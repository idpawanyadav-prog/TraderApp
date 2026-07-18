# TraderApp

TraderApp is a Flask-based trading dashboard that connects to broker APIs, loads chart data, and provides a simple web UI for charting and broker connection.

## Features
- Start the app with a single batch file
- Use a bundled Python 3.6 runtime when available
- Connect to supported brokers from the web UI
- Load chart data and view candles in the browser

## Requirements
- Windows
- Python 3.6 (bundled locally in the `python36` folder when available)

## Quick Start
1. Open the project folder.
2. Run `install_python.bat` if you do not already have Python 3.6 available.
3. Run `start_server.bat`.
4. Open the URL shown in the terminal:
   - http://127.0.0.1:5000/

## Files
- `app.py` - Flask application entry point
- `start_server.bat` - Starts the app and opens the browser
- `install_python.bat` - Installs Python 3.6 into the local `python36` folder
- `install_libs.bat` - Installs Python dependencies into the local `libs` folder
- `requirements.txt` - Python dependency list

## Notes
- The app uses the local `libs` folder for bundled Python packages.
- If the bundled Python runtime is missing, the launcher will try the original Python 3.6 installation path on the machine.
