# TraderApp

TraderApp is a Flask-based trading dashboard that connects to broker APIs, loads chart data, and provides a simple web UI for charting and broker connection.

## Features
- Start the app with a single batch file
- Optional bundled Python 3.14 runtime
- Connect to supported brokers from the web UI
- Load chart data and view candles in the browser

## Requirements
- Windows
- Python 3.10 or newer (including 3.14). A local copy can be installed into `python314` with `install_python.bat`.

Python 3.6 is no longer supported.

## Quick Start
1. Open the project folder.
2. Run `install_python.bat` if you do not already have Python 3.10+ available.
3. Run `install_libs.bat` to install dependencies into `libs` (required after upgrading Python).
4. Run `start_server.bat`.
5. Open the URL shown in the terminal:
   - http://127.0.0.1:5000/

## Files
- `app.py` - Flask application entry point
- `start_server.bat` - Starts the app and opens the browser
- `install_python.bat` - Installs Python 3.14 into the local `python314` folder
- `install_libs.bat` - Installs Python dependencies into the local `libs` folder
- `requirements.txt` - Python dependency list

## Notes
- The app uses the local `libs` folder for bundled Python packages. Those packages must be installed with the same Python version that runs the app.
- An old `python36` folder can be deleted if you no longer need it.
