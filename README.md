# Diário Saúde (Health Journal) 📊

A Progressive Web App (PWA) for tracking daily health activities, sleep patterns, and wellness metrics with weather integration and offline capabilities.

## 🌟 Features

### 📱 Quick Actions
- **Hydration Tracking**: Record water intake (510ml, 700ml)
- **Exercise & Wellness**: Track workouts, isotonic drinks, sun exposure
- **Health Monitoring**: Blood glucose, food intake, coffee consumption
- **Lifestyle Tracking**: Alcohol, sweets, bathroom visits, night awakenings

### 😴 Sleep Management
- **Sleep Cycles**: Track sleep start/end times
- **Day/Night Cycles**: Automatic cycle detection and visualization
- **Sleep Quality**: Monitor sleep patterns and interruptions

### 🌤️ Weather Integration
- **Location-based**: Automatically detects your location
- **Weather Correlation**: Links health events with local weather conditions
- **Offline Caching**: Stores weather data for offline access

### 💾 Data Management
- **Local Storage**: All data stored locally using IndexedDB
- **Export/Import**: Backup and restore your health data
- **Offline First**: Works completely offline after initial load

## 🚀 Getting Started

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd health
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Open your browser**
   Navigate to `http://localhost:5173`

### Build for Production

```bash
npm run build
npm run preview
```

## 🛠️ Tech Stack

- **Frontend**: Vanilla JavaScript (ES6+)
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **Database**: IndexedDB (via idb library)
- **PWA**: Progressive Web App capabilities
- **Weather API**: Open-Meteo (free, no API key required)

## 📱 PWA Features

- **Installable**: Add to home screen on mobile devices
- **Offline Support**: Works without internet connection
- **Responsive Design**: Optimized for mobile and desktop
- **Fast Loading**: Built with modern web technologies

## 🗄️ Data Structure

### Events
Each health event includes:
- **Type**: Event category (water, exercise, sleep, etc.)
- **Timestamp**: When the event occurred
- **Weather Data**: Temperature and humidity (if available)
- **Location**: GPS coordinates for weather correlation

### Sleep Cycles
- **NIGHT**: From sleep start to sleep end
- **DAY**: From sleep end to next sleep start
- **Automatic Detection**: Cycles are built from sleep events

## 🔧 Configuration

### Weather Settings
- Location detection via browser geolocation
- Automatic weather data fetching
- 24-hour forecast caching

### Data Export/Import
- JSON format for data portability
- Complete backup of all health records
- Easy migration between devices

## 📊 Usage Guide

### Recording Health Events
1. **Quick Actions**: Use the colored buttons for common activities
2. **Sleep Tracking**: Click "Dormir agora" when going to bed, "Acordar agora" when waking up
3. **Manual Events**: Edit or delete events as needed

### Navigating Cycles
- **Current**: View today's activities
- **Previous/Next**: Navigate between different day/night cycles
- **Event List**: See all activities within the selected cycle

### Data Management
- **Export**: Download your health data as JSON
- **Import**: Restore data from a previous export
- **Offline**: All data is stored locally on your device

## 🌐 Browser Support

- **Modern Browsers**: Chrome, Firefox, Safari, Edge
- **Mobile**: iOS Safari, Chrome Mobile, Samsung Internet
- **PWA**: Full PWA support on compatible devices

## 🔒 Privacy & Security

- **Local Storage**: All data stays on your device
- **No Cloud**: No data is sent to external servers
- **Location**: Only used for weather data (optional)
- **Offline**: Works completely offline

## 🚧 Development

### Project Structure
```
health/
├── src/
│   ├── main.js          # Main application logic
│   └── app.css          # Tailwind CSS styles
├── public/               # Static assets
├── index.html           # Main HTML file
├── package.json         # Dependencies and scripts
└── tailwind.config.js   # Tailwind configuration
```

### Key Functions
- **Database Management**: IndexedDB setup and operations
- **Event Handling**: CRUD operations for health events
- **Cycle Building**: Automatic day/night cycle detection
- **Weather Integration**: Location-based weather data
- **UI Rendering**: Dynamic event list and cycle display

### Adding New Event Types
1. Add button to HTML with `data-action` attribute
2. Handle in JavaScript event listeners
3. Update event rendering templates

## 📝 License

This project is licensed under the ISC License.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 🐛 Known Issues

- Weather data requires location permission
- Some browsers may have IndexedDB limitations
- PWA installation varies by device/browser

## 📞 Support

For issues or questions:
- Check browser console for errors
- Verify location permissions are enabled
- Ensure IndexedDB is supported in your browser

---

**Built with ❤️ for better health tracking and wellness management**
