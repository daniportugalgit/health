import { openDB } from 'idb';
import './app.css';

const DB_NAME = 'health-diary';
const DB_VERSION = 2; // mantemos v2
const state = {
  currentCycleIdx: 0, // índice do ciclo selecionado
  cycles: [],         // cache de ciclos
};

const ymd = d => d.toISOString().slice(0,10);
const parseLocal = v => new Date(v);
const toLocalValue = (date)=>{
  const pad = n => String(n).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

async function db() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const events = db.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('by_ts', 'ts');
        events.createIndex('by_date', 'dateKey');
        db.createObjectStore('settings', { keyPath: 'key' });
        const weather = db.createObjectStore('weather_cache', { keyPath: 'key' });
        weather.createIndex('by_date', 'dateKey');
      }
      if (oldVersion < 2) {
        const sleep = db.createObjectStore('sleep_sessions', { keyPath: 'id' });
        sleep.createIndex('by_dateKey', 'dateKey');
      }
    }
  });
}

const uuid = () =>
  (crypto.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
      const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16);
    }));

/** ------------ WEATHER ------------ **/
async function getLatLon() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) }),
      () => resolve(null),
      { timeout: 8000 }
    );
  });
}

async function getDailyWeatherArrays(date, lat, lon) {
  const dbase = await db();
  const dateKey = ymd(date);
  const key = `${dateKey}:${lat}:${lon}`;
  const cached = await dbase.get('weather_cache', key);
  if (cached?.hours && cached?.temps && cached?.hums) return cached;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', dateKey);
  url.searchParams.set('end_date', dateKey);

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error('Falha ao buscar clima');
  const json = await resp.json();

  const hours = (json.hourly?.time || []).map(t => +new Date(t));
  const temps = json.hourly?.temperature_2m || [];
  const hums  = json.hourly?.relative_humidity_2m || [];

  const rec = {
    key, dateKey, lat, lon,
    hours, temps, hums,
    minTemp: Math.min(...temps), maxTemp: Math.max(...temps),
    minHum : Math.min(...hums),  maxHum : Math.max(...hums),
    fetchedAt: Date.now()
  };
  await dbase.put('weather_cache', rec);
  return rec;
}

function nearestWeatherAtTs(record, ts) {
  if (!record?.hours?.length) return null;
  let bestIdx = 0;
  let bestDiff = Math.abs(record.hours[0] - ts);
  for (let i=1;i<record.hours.length;i++) {
    const diff = Math.abs(record.hours[i] - ts);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  const temp = record.temps[bestIdx];
  const hum  = record.hums[bestIdx];
  if (typeof temp !== 'number' || typeof hum !== 'number') return null;
  return { temp, hum };
}

async function weatherForEventTs(ts) {
  const loc = await getLatLon();
  if (!loc) return null;
  const localDate = new Date(ts);
  const rec = await getDailyWeatherArrays(localDate, loc.lat, loc.lon);
  const hit = nearestWeatherAtTs(rec, ts);
  if (!hit) return null;
  return { ...hit, lat: rec.lat, lon: rec.lon };
}

/** -------------------- CRUD eventos -------------------- **/

/** Helper function to check if we're currently in a night cycle */
async function isCurrentlyInNightCycle() {
  const cycles = await refreshCycles();
  if (!cycles.length) return false;
  
  const currentTime = Date.now();
  const currentCycle = cycles[cycles.length - 1]; // Get the most recent cycle
  
  // If the current cycle is NIGHT and has no end time, or if we're within a NIGHT cycle
  if (currentCycle.type === 'NIGHT') {
    if (!currentCycle.endTs) return true; // Ongoing night cycle
    if (currentTime >= currentCycle.startTs && currentTime <= currentCycle.endTs) return true;
  }
  
  return false;
}

/** Helper function to check if there's a recent wake event within the last 10 minutes */
async function hasRecentWakeEvent(withinMinutes = 10) {
  const currentTime = Date.now();
  const cutoffTime = currentTime - (withinMinutes * 60 * 1000);
  
  const dbase = await db();
  const range = IDBKeyRange.bound(cutoffTime, currentTime);
  const idx = dbase.transaction('events').store.index('by_ts');
  
  for await (const cursor of idx.iterate(range)) {
    if (cursor.value.type === 'wake') {
      return true;
    }
  }
  
  return false;
}

async function addEvent(ev) {
  if (ev.type === 'sleep_start' || ev.type === 'sleep_end' || ev.type === 'wake') {
    try {
      const w = await weatherForEventTs(ev.ts);
      if (w) ev.weather = w;
    } catch {}
  }
  const dbase = await db();
  const dateKey = ymd(new Date(ev.ts));
  await dbase.put('events', { id: uuid(), dateKey, ...ev });
  await renderCycle(); // re-render com base em ciclos
}

async function updateEvent(ev) {
  if (ev.type === 'sleep_start' || ev.type === 'sleep_end' || ev.type === 'wake') {
    try {
      const w = await weatherForEventTs(ev.ts);
      if (w) ev.weather = w;
    } catch {}
  }
  const dbase = await db();
  const dateKey = ymd(new Date(ev.ts));
  await dbase.put('events', { ...ev, dateKey });
}

async function deleteEvent(id) {
  const d = await db();
  await d.delete('events', id);
}

/** Helpers para buscar eventos **/
async function getAllEvents() {
  const d = await db();
  const idx = d.transaction('events').store.index('by_ts');
  const out = [];
  for await (const c of idx.iterate(null)) out.push(c.value);
  out.sort((a,b)=>a.ts-b.ts);
  return out;
}

async function eventsBetween(startTs, endTs) {
  const d = await db();
  const range = IDBKeyRange.bound(startTs, endTs);
  const idx = (await d).transaction('events').store.index('by_ts');
  const out = [];
  for await (const c of idx.iterate(range)) out.push(c.value);
  out.sort((a,b)=>a.ts-b.ts);
  return out;
}

/** ---------- Construção de CICLOS (DIA/NOITE) ----------
Regras:
- NOITE: de sleep_start (Dormir) até sleep_end (Acordar).
- DIA: de sleep_end (Acordar) até próxima sleep_start (Dormir).
- Sempre estamos em um único ciclo (DIA ou NOITE). Se não houver qualquer evento,
  assumimos ciclo atual = DIA começando no "agora" (só para UI).
- "Acordei (noite)" (type 'wake') não fecha ciclo.
**/
function buildCyclesFromEvents(sortedEvents) {
  const cycles = [];
  let phase = 'DAY';
  let startTs = null;
  let startEventRef = null;

  const firstSleepStart = sortedEvents.find(e => e.type==='sleep_start');
  const firstSleepEnd   = sortedEvents.find(e => e.type==='sleep_end');

  if (firstSleepStart && (!firstSleepEnd || firstSleepStart.ts < firstSleepEnd.ts)) {
    phase = 'NIGHT';
    startTs = firstSleepStart.ts;
    startEventRef = firstSleepStart;
  } else if (firstSleepEnd) {
    phase = 'DAY';
    startTs = firstSleepEnd.ts;
    startEventRef = firstSleepEnd;
  } else if (sortedEvents.length) {
    phase = 'DAY';
    startTs = sortedEvents[0].ts;
    startEventRef = null;
  } else {
    const now = Date.now();
    cycles.push({
      id: 'virtual-now',
      type: 'DAY',
      startTs: now,
      endTs: null,
      startEvent: null,
      endEvent: null,
    });
    return cycles;
  }

  for (const e of sortedEvents) {
    if (e.type === 'sleep_start') {
      if (phase === 'DAY') {
        if (startTs != null) {
          cycles.push({
            id: uuid(),
            type: 'DAY',
            startTs,
            endTs: e.ts,
            startEvent: startEventRef,
            endEvent: e,
          });
        }
        phase = 'NIGHT';
        startTs = e.ts;
        startEventRef = e;
      } else {
        cycles.push({
          id: uuid(),
          type: 'NIGHT',
          startTs,
          endTs: e.ts,
          startEvent: startEventRef,
          endEvent: null,
        });
        phase = 'NIGHT';
        startTs = e.ts;
        startEventRef = e;
      }
    } else if (e.type === 'sleep_end') {
      if (phase === 'NIGHT') {
        cycles.push({
          id: uuid(),
          type: 'NIGHT',
          startTs,
          endTs: e.ts,
          startEvent: startEventRef,
          endEvent: e,
        });
        phase = 'DAY';
        startTs = e.ts;
        startEventRef = e;
      } else {
        phase = 'DAY';
        startTs = e.ts;
        startEventRef = e;
      }
    }
  }

  cycles.push({
    id: uuid(),
    type: phase,
    startTs,
    endTs: null,
    startEvent: startEventRef,
    endEvent: null,
  });

  return cycles;
}

/** Calcular estatísticas do ciclo **/
async function calcCycleStats(cycle) {
  const endTs = cycle.endTs ?? Date.now();
  const evs = await eventsBetween(cycle.startTs, endTs);

  const waterMl = evs.filter(e => e.type==='water' && typeof e.amount==='number')
                     .reduce((s,e)=>s+e.amount, 0);
  const urinate = evs.filter(e => e.type==='urinate').length;
  const wake    = evs.filter(e => e.type==='wake').length;
  const foodCnt = evs.filter(e => e.type==='food').length;
  const exercised = evs.some(e => e.type==='exercise');
  const glicemiaCount = evs.filter(e => e.type==='glicemia').length;
  const glicemiaLevels = evs.filter(e => e.type==='glicemia' && e.level).map(e => e.level);
  const solCount = evs.filter(e => e.type==='sol').length;
  const solDuration = evs.filter(e => e.type==='sol' && e.duration).reduce((s,e)=>s+parseInt(e.duration), 0);

  return {
    waterMl,
    urinate,
    wake: cycle.type==='NIGHT' ? wake : undefined,
    foodCnt: cycle.type==='DAY' ? foodCnt : undefined,
    exercised: cycle.type==='DAY' ? exercised : undefined,
    glicemiaCount,
    glicemiaLevels,
    solCount,
    solDuration,
    events: evs,
  };
}

/** -------------------- UI -------------------- **/
function describeEvent(e) {
  const dt = new Date(e.ts);
  const when = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;

  const wh = (e.weather && (typeof e.weather.temp==='number') && (typeof e.weather.hum==='number'))
    ? ` • T ${e.weather.temp.toFixed(1)}°C • U ${e.weather.hum}%`
    : '';

  switch (e.type) {
    case 'water':   return [`💧 Água ${e.subtype==='510ml'?'510':'700'}ml`, when];
    case 'wake':    return ['😴 Acordei (noite)', when + wh]; // não fecha ciclo
    case 'urinate': return ['🚽 Urinei', when];
    case 'exercise':return ['💪 Exercício', when];
    case 'food':    return [e.note ? `🍽️ Comida: ${e.note}` : '🍽️ Comida', when];
    case 'coffee':  return ['☕ Cafezinho', when];
    case 'glicemia': return [e.level ? `🩸 Glicemia: ${e.level} mg/dL` : '🩸 Glicemia', when];
    case 'sol':      return [e.duration ? `☀️ Sol: ${e.duration} min` : '☀️ Sol', when];
    case 'sweet':   return [e.note ? `🍬 Doce: ${e.note}` : '🍬 Doce', when];
    case 'alcool':  return [e.note ? `🍺 Álcool: ${e.note}` : '🍺 Álcool', when];
    case 'isotonic': return [e.amount ? `🥤 Isotônico: ${e.amount} ml` : '🥤 Isotônico', when];
    case 'sleep_start': return ['😴 Dormir', when + wh];
    case 'sleep_end':   return ['🌅 Acordar', when + wh];
    default:        return ['📝 Evento', when];
  }
}

function promptTime(defaultTs) {
  const val = prompt('Edite a data/hora (YYYY-MM-DDTHH:mm):', toLocalValue(new Date(defaultTs)));
  if (!val) return null;
  const parsed = parseLocal(val);
  if (isNaN(parsed)) return null;
  return +parsed;
}

function hhmm(tsOrDate) {
  const d = (tsOrDate instanceof Date) ? tsOrDate : new Date(tsOrDate);
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function refreshCycles() {
  const all = await getAllEvents();
  const cycles = buildCyclesFromEvents(all);
  state.cycles = cycles;
  return cycles;
}

function titleEl() {
  // pega o <h2> onde antes era "Hoje"
  const el = document.getElementById('btn-today')?.closest('section')?.querySelector('h2');
  return el || null;
}

function whFromEvent(ev) {
  if (ev?.weather && typeof ev.weather.temp==='number' && typeof ev.weather.hum==='number') {
    return ` • T ${ev.weather.temp.toFixed(1)}°C • U ${ev.weather.hum}%`;
  }
  return '';
}

async function renderCycle() {
  // 1) Recalcula ciclos a partir dos eventos
  const cycles = await refreshCycles();
  if (!cycles.length) return; // should not happen

  // 2) Ajusta índice atual
  if (state.currentCycleIdx < 0) state.currentCycleIdx = 0;
  if (state.currentCycleIdx >= cycles.length) state.currentCycleIdx = cycles.length - 1;

  const cycle = cycles[state.currentCycleIdx];

  // 3) Atualiza o título "Ciclo atual: ..."
  const h2 = titleEl();
  if (h2) h2.textContent = `Ciclo atual: ${cycle.type === 'NIGHT' ? 'NOITE' : 'DIA'}`;

  // 4) Limpa lista e monta card do ciclo + eventos
  const list = document.getElementById('event-list');
  list.innerHTML = '';

  // Estatísticas
  const stats = await calcCycleStats(cycle);

  // Labels e horários do card-resumo
  const isNight = cycle.type === 'NIGHT';
  const startLabel = isNight ? 'Dormir' : 'Acordar';
  const endLabel   = isNight ? 'Acordar' : 'Dormir';

  const startWh = whFromEvent(cycle.startEvent);
  const endWh   = whFromEvent(cycle.endEvent);

  const cardColor = isNight
    ? 'bg-sky-800 border-sky-600 text-white'
    : 'bg-gray-800 border-gray-600 text-white';

  const liCard = document.createElement('li');
  liCard.className = `p-3 flex items-start justify-between ${cardColor} rounded-xl mb-2 border`;
  liCard.innerHTML = `
    <div>
      <div class="font-medium text-white">${isNight ? 'Noite' : 'Dia'}</div>
      <div class="text-xs text-gray-200">
        ${startLabel}: ${cycle.startTs ? hhmm(cycle.startTs) : '--:--'}${startWh}
        ${cycle.endTs ? ` • ${endLabel}: ${hhmm(cycle.endTs)}${endWh}` : ` • (${endLabel.toLowerCase()} ainda não definido)`}
      </div>
      <div class="mt-1 text-xs text-gray-200">
        Água: <strong class="text-white">${stats.waterMl} ml</strong>
        • Micções: <strong class="text-white">${stats.urinate}</strong>
        ${isNight ? `• Despertares: <strong class="text-white">${stats.wake ?? 0}</strong>` : ''}
        ${!isNight ? `• Refeições: <strong class="text-white">${stats.foodCnt ?? 0}</strong> • Exercício: <strong class="text-white">${stats.exercised ? 'sim' : 'não'}</strong>` : ''}
        ${stats.glicemiaLevels.length > 0 ? `• Glicemia: <strong class="text-white">${stats.glicemiaLevels.join(', ')} mg/dL</strong>` : ''}
        ${stats.solDuration > 0 ? `• Sol: <strong class="text-white">${stats.solDuration} min</strong>` : ''}
      </div>
    </div>
    <div class="flex flex-col gap-1 shrink-0">
      <button class="btn-edit-cycle px-2 py-1 text-xs rounded-lg border border-gray-500 bg-gray-700 text-gray-200 hover:bg-gray-600">Editar</button>
      <button class="btn-del-cycle px-2 py-1 text-xs rounded-lg border border-gray-500 bg-gray-700 text-red-400 hover:bg-gray-600">Apagar</button>
    </div>
  `;

  // Editar horários do ciclo (ajusta events de borda se existirem)
  liCard.querySelector('.btn-edit-cycle')?.addEventListener('click', async ()=>{
    // editar início (se existir evento)
    if (cycle.startEvent) {
      const newStart = promptTime(cycle.startEvent.ts);
      if (newStart) {
        await updateEvent({ ...cycle.startEvent, ts: newStart });
      }
    }
    // editar fim (se existir evento)
    if (cycle.endEvent) {
      const newEnd = promptTime(cycle.endEvent.ts);
      if (newEnd) {
        await updateEvent({ ...cycle.endEvent, ts: newEnd });
      }
    }
    await renderCycle();
  });

  // Apagar ciclo = apagar eventos de borda existentes
  liCard.querySelector('.btn-del-cycle')?.addEventListener('click', async ()=>{
    if (!confirm('Apagar este ciclo (remover eventos de borda)?')) return;
    const dbase = await db();
    const tx = dbase.transaction('events','readwrite');
    if (cycle.startEvent?.id) await tx.store.delete(cycle.startEvent.id);
    if (cycle.endEvent?.id)   await tx.store.delete(cycle.endEvent.id);
    await tx.done;
    await renderCycle();
  });

  list.appendChild(liCard);

  // 5) Renderizar eventos dentro do ciclo
  const tpl = document.getElementById('tpl-event-item');
  stats.events.forEach(e=>{
    const li = tpl.content.cloneNode(true);
    const [title, subtitle] = describeEvent(e);
    li.querySelector('.font-medium').textContent = title;
    li.querySelector('.text-xs').textContent = subtitle;
    
    // Add color styling based on event type
    const eventItem = li.querySelector('li');
    if (eventItem) {
      switch (e.type) {
        case 'water':
          eventItem.className = 'p-3 flex items-start justify-between bg-sky-500 text-white border-l-4 border-sky-500 rounded-xl';
          break;
        case 'wake':
          eventItem.className = 'p-3 flex items-start justify-between bg-red-500 text-white border-l-4 border-red-500 rounded-xl';
          break;
        case 'urinate':
          eventItem.className = 'p-3 flex items-start justify-between bg-yellow-600 text-white border-l-4 border-yellow-600 rounded-xl';
          break;
        case 'exercise':
          eventItem.className = 'p-3 flex items-start justify-between bg-green-600 text-white border-l-4 border-green-600 rounded-xl';
          break;
        case 'food':
          eventItem.className = 'p-3 flex items-start justify-between bg-blue-700 text-white border-l-4 border-blue-700 rounded-xl';
          break;
        case 'coffee':
          eventItem.className = 'p-3 flex items-start justify-between bg-amber-600 text-white border-l-4 border-amber-600 rounded-xl';
          break;
        case 'sweet':
          eventItem.className = 'p-3 flex items-start justify-between bg-pink-500 text-white border-l-4 border-pink-500 rounded-xl';
          break;
        case 'glicemia':
          eventItem.className = 'p-3 flex items-start justify-between bg-purple-500 text-white border-l-4 border-purple-500 rounded-xl';
          break;
        case 'alcool':
          eventItem.className = 'p-3 flex items-start justify-between bg-red-600 text-white border-l-4 border-red-600 rounded-xl';
          break;
        case 'isotonic':
          eventItem.className = 'p-3 flex items-start justify-between bg-green-400 text-black border-l-4 border-green-500 rounded-xl';
          break;
        case 'sol':
          eventItem.className = 'p-3 flex items-start justify-between bg-yellow-400 text-black border-l-4 border-yellow-500 rounded-xl';
          break;
        case 'sleep_start':
        case 'sleep_end':
          eventItem.className = 'p-3 flex items-start justify-between bg-sky-700 text-white border-l-4 border-sky-700 rounded-xl';
          break;
        default:
          eventItem.className = 'p-3 flex items-start justify-between bg-gray-800 text-gray-100 border-l-4 border-gray-700 rounded-xl';
      }
      
              // Also ensure the time text is white for colored backgrounds (except sol and isotonic which use black text)
        const timeElement = eventItem.querySelector('.text-xs');
        if (timeElement && (e.type !== 'default')) {
          if (e.type === 'sol' || e.type === 'isotonic') {
            timeElement.className = 'text-xs text-black';
          } else {
            timeElement.className = 'text-xs text-white';
          }
        }
      }
      
      // Update button styling to match the dark theme
      const editBtn = li.querySelector('.btn-edit');
      const deleteBtn = li.querySelector('.btn-delete');
      
      if (editBtn) {
        editBtn.className = 'btn-edit px-2 py-1 text-xs rounded-lg border border-gray-500 bg-gray-700 text-gray-200 hover:bg-gray-600';
      }
      
      if (deleteBtn) {
        deleteBtn.className = 'btn-delete px-2 py-1 text-xs rounded-lg border border-gray-500 bg-gray-700 text-red-400 hover:bg-gray-600';
      }
      
      // Editar horário
      editBtn?.addEventListener('click', async ()=>{
        if (e.type === 'glicemia') {
          // For glicemia events, allow editing both time and level
          const newTs = promptTime(e.ts);
          if (!newTs) return;
          
          const newLevel = prompt('Editar nível de glicemia:\n\nDigite apenas o número (ex: 120, 95, 180)\n\nmg/dL', e.level || '');
          if (!newLevel || !newLevel.trim()) return;
          
          const cleanLevel = newLevel.trim().replace(/[^\d]/g, '');
          if (cleanLevel && cleanLevel.length >= 2 && cleanLevel.length <= 3) {
            await updateEvent({ ...e, ts: newTs, level: cleanLevel });
          } else {
            alert('Por favor, digite um número válido entre 2 e 3 dígitos (ex: 95, 120, 180)');
            return;
          }
        } else if (e.type === 'sol') {
          // For sol events, allow editing both time and duration
          const newTs = promptTime(e.ts);
          if (!newTs) return;
          
          const newDuration = prompt('Editar duração no sol:\n\nDigite apenas o número de minutos (ex: 10, 15, 30)', e.duration || '');
          if (!newDuration || !newDuration.trim()) return;
          
          const cleanDuration = newDuration.trim().replace(/[^\d]/g, '');
          if (cleanDuration && parseInt(cleanDuration) >= 10) {
            await updateEvent({ ...e, ts: newTs, duration: cleanDuration });
          } else {
            alert('Por favor, digite um número válido de 10 minutos ou mais (ex: 10, 15, 30)');
            return;
          }
        } else if (e.type === 'alcool') {
          // For alcool events, allow editing both time and note
          const newTs = promptTime(e.ts);
          if (!newTs) return;
          
          const newNote = prompt('Editar bebida alcoólica:', e.note || '');
          await updateEvent({ ...e, ts: newTs, note: newNote || '' });
        } else if (e.type === 'isotonic') {
          // For isotonic events, allow editing both time and amount
          const newTs = promptTime(e.ts);
          if (!newTs) return;
          
          const newAmount = prompt('Editar quantidade de isotônico:\n\nDigite apenas o número em ml (ex: 500, 750, 1000)', e.amount || '');
          if (!newAmount || !newAmount.trim()) return;
          
          const cleanAmount = newAmount.trim().replace(/[^\d]/g, '');
          if (cleanAmount && parseInt(cleanAmount) >= 100) {
            await updateEvent({ ...e, ts: newTs, amount: parseInt(cleanAmount) });
          } else {
            alert('Por favor, digite um número válido de 100ml ou mais (ex: 500, 750, 1000)');
            return;
          }
        } else {
          // For other events, only edit time
          const newTs = promptTime(e.ts);
          if (!newTs) return;
          await updateEvent({ ...e, ts: newTs });
        }
        await renderCycle();
      });

      // Apagar registro
      deleteBtn?.addEventListener('click', async ()=>{
        const ok = confirm('Apagar este registro?');
        if (!ok) return;
        await deleteEvent(e.id);
        await renderCycle();
      });

    list.appendChild(li);
  });
}

/** -------------------- AÇÕES RÁPIDAS -------------------- **/
const nowMs = ()=>Date.now();
function attachQuickButtons() {
  const urBtn = document.querySelector('[data-action="urinate"]');
  if (urBtn) urBtn.textContent = '🚽 Urinei';

  document.querySelectorAll('[data-action]').forEach(btn=>{
    const action = btn.getAttribute('data-action');
    const handler = async ()=>{
      let ts = nowMs();
      if (action==='water-510') await addEvent({ type:'water', subtype:'510ml', amount:510, ts });
      else if (action==='water-700') await addEvent({ type:'water', subtype:'700ml', amount:700, ts });
      else if (action==='wake') await addEvent({ type:'wake', ts });
      else if (action==='urinate') {
        // Check if we're in a night cycle and need to add a wake event
        const isNight = await isCurrentlyInNightCycle();
        if (isNight) {
          const hasRecentWake = await hasRecentWakeEvent(10);
          if (!hasRecentWake) {
            // Add wake event 1 second before urinate event
            await addEvent({ type:'wake', ts: ts - 1000 });
          }
        }
        await addEvent({ type:'urinate', ts });
      }
      else if (action==='exercise') await addEvent({ type:'exercise', ts });
      else if (action==='food') {
        const note = prompt('O que você comeu/bebeu?','');
        await addEvent({ type:'food', note: note||'', ts });
      }
      else if (action==='coffee') await addEvent({ type:'coffee', ts });
      else if (action==='glicemia') {
        const level = prompt('Qual é o seu nível de glicemia?\n\nDigite apenas o número (ex: 120, 95, 180)\n\nmg/dL', '');
        if (level && level.trim()) {
          const cleanLevel = level.trim().replace(/[^\d]/g, ''); // Remove non-digits
          if (cleanLevel && cleanLevel.length >= 2 && cleanLevel.length <= 3) {
            await addEvent({ type:'glicemia', level: cleanLevel, ts });
          } else {
            alert('Por favor, digite um número válido entre 2 e 3 dígitos (ex: 95, 120, 180)');
          }
        }
      }
      else if (action==='sol') {
        const duration = prompt('Quanto tempo você ficou no sol?\n\nDigite apenas o número de minutos (ex: 10, 15, 30)', '');
        if (duration && duration.trim()) {
          const cleanDuration = duration.trim().replace(/[^\d]/g, ''); // Remove non-digits
          if (cleanDuration && parseInt(cleanDuration) >= 10) {
            await addEvent({ type:'sol', duration: cleanDuration, ts });
          } else {
            alert('Por favor, digite um número válido de 10 minutos ou mais (ex: 10, 15, 30)');
          }
        }
      }
      else if (action==='sweet') {
        const note = prompt('Que doce você comeu?','');
        await addEvent({ type:'sweet', note: note||'', ts });
      }
      else if (action==='alcool') {
        const note = prompt('Que bebida alcoólica você bebeu?','');
        await addEvent({ type:'alcool', note: note||'', ts });
      }
      else if (action==='isotonic') {
        const amount = prompt('Quantos ml de isotônico você bebeu?\n\nDigite apenas o número (ex: 500, 750, 1000)', '');
        if (amount && amount.trim()) {
          const cleanAmount = amount.trim().replace(/[^\d]/g, ''); // Remove non-digits
          if (cleanAmount && parseInt(cleanAmount) >= 100) {
            await addEvent({ type:'isotonic', amount: parseInt(cleanAmount), ts });
          } else {
            alert('Por favor, digite um número válido de 100ml ou mais (ex: 500, 750, 1000)');
          }
        }
      }
    };
    btn.addEventListener('click', ()=>handler(false));
  });
}

/** -------------------- BOTÕES DE SONO -------------------- **/
function attachSleepButtons() {
  const startBtn = document.getElementById('btn-now-start');
  const endBtn   = document.getElementById('btn-now-end');

  const startHandler = async () => {
    // Check if we're already in a night cycle
    const isNight = await isCurrentlyInNightCycle();
    if (isNight) {
      alert('⚠️ Você já está em um ciclo de NOITE!\n\nClique em "Acordar agora" para finalizar o sono atual.');
      return;
    }
    
    let ts = nowMs();
    await addEvent({ type: 'sleep_start', ts });
  };

  const endHandler = async () => {
    // Check if we're already in a day cycle
    const isNight = await isCurrentlyInNightCycle();
    if (!isNight) {
      alert('⚠️ Você já está em um ciclo de DIA!\n\nClique em "Dormir agora" para iniciar um novo sono.');
      return;
    }
    
    let ts = nowMs();
    await addEvent({ type: 'sleep_end', ts });
  };

  startBtn?.addEventListener('click', startHandler);
  endBtn  ?.addEventListener('click', endHandler);
}



/** -------------------- NAV / EXPORT -------------------- **/
function attachNav() {
  const btnToday = document.getElementById('btn-today');
  const btnPrev  = document.getElementById('btn-prev');
  const btnNext  = document.getElementById('btn-next');

  btnToday.onclick = async ()=>{
    await refreshCycles();
    state.currentCycleIdx = Math.max(0, state.cycles.length - 1);
    await renderCycle();
  };
  btnPrev.onclick = async ()=>{
    state.currentCycleIdx = Math.max(0, state.currentCycleIdx - 1);
    await renderCycle();
  };
  btnNext.onclick = async ()=>{
    state.currentCycleIdx = Math.min(state.cycles.length - 1, state.currentCycleIdx + 1);
    await renderCycle();
  };
}

async function exportJSON() {
  const d = await db();
  const all = {
    events: await d.getAll('events'),
    settings: await d.getAll('settings'),
    weather_cache: await d.getAll('weather_cache'),
  };
  const blob = new Blob([JSON.stringify(all,null,2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `diario-saude-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function importJSON(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const d = await db();
  const tx = d.transaction(['events','settings','weather_cache'],'readwrite');
  if (Array.isArray(data.events)) for (const e of data.events) await tx.objectStore('events').put(e);
  if (Array.isArray(data.settings)) for (const s of data.settings) await tx.objectStore('settings').put(s);
  if (Array.isArray(data.weather_cache)) for (const w of data.weather_cache) await tx.objectStore('weather_cache').put(w);
  await tx.done;
  await renderCycle();
}
function attachExportImport() {
  document.getElementById('btn-export').onclick = exportJSON;
  const file = document.getElementById('file-import');
  file.onchange = ()=>{ if (file.files?.length) importJSON(file.files[0]); file.value=''; };
}

// SW (registra em produção)
if ('serviceWorker' in navigator && import.meta.env?.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
  });
}

window.addEventListener('DOMContentLoaded', async ()=>{
  attachQuickButtons();
  attachSleepButtons();
  attachNav();
  attachExportImport();
  await renderCycle();
});
