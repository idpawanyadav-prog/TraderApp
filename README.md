# TraderApp

TraderApp is a Flask-based trading dashboard that connects to broker APIs, loads chart data, and provides a simple web UI for charting and broker connection.

## Features
- Start the app with a single batch file
- Optional bundled Python 3.14 runtime
- Connect to supported brokers from the web UI
- Load chart data and view candles in the browser

## Requirements
- Windows, macOS, or Linux
- Python 3.10 or newer (including 3.14). On Windows a local copy can be installed into `python314` with `install_python.bat`. On macOS run `setup_mac.sh` or install from python.org.

Python 3.6 is no longer supported.

## Quick Start (Windows)
1. Open the project folder.
2. Run `install_python.bat` if you do not already have Python 3.10+ available.
3. Run `install_libs.bat` to install dependencies into `libs` (required after upgrading Python).
4. Run `start_server.bat`.
5. Open the URL shown in the terminal:
   - http://127.0.0.1:5000/

## Quick Start (macOS / Linux)
1. Open Terminal in the project folder.
2. Run `./setup_mac.sh` if you do not already have Python 3.10+ (installs via Homebrew).
3. Run `./install_libs.sh` to install dependencies into `libs`.
4. Run `./start_server.sh`.

## Use from iPhone / iPad
- The server binds to `0.0.0.0` by default, so any device on the same Wi-Fi network can open it.
- After starting, look for the **"iPhone/iPad (same Wi-Fi)"** URL printed in the terminal (e.g. `http://192.168.1.23:5000/`) and open it in Safari.
- For a full-screen, app-like experience: in Safari tap **Share → Add to Home Screen**.
- To restrict the server to localhost only, run: `TRADERAPP_HOST=127.0.0.1 ./start_server.sh` (or set the same env var on Windows).

## Notes
- The Excel broker (`xlwings`) works on Windows and macOS. On macOS, Microsoft Excel for Mac must be installed; COM (`pywin32`) is used on Windows only.
- The app uses the local `libs` folder for bundled Python packages. Those packages must be installed with the same Python version that runs the app.
- An old `python36` folder can be deleted if you no longer need it.
