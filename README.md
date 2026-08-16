# TraderApp

TraderApp is a Flask + Socket.IO trading dashboard. It connects to broker APIs (or Excel), loads OHLCV data, charts candles in the browser, and includes pair/option analysis tools.

## Features

- **Home chart** — search instruments, load candles, drawing tools, zoom/pan, dark/light theme
- **Watchlist** — multiple per-broker watchlists (drag to reorder, live quotes) docked beside the chart
- **Stock news** — a news panel below the watchlist for the selected symbol (Dhan, 5Paisa, and Yahoo; Excel is excluded)
- **Brokers** — Dhan, 5Paisa, Yahoo Finance, and Excel (`xlwings`)
- **Live updates** — Socket.IO feed for 5Paisa (polled and pushed to the chart)
- **Custom indicators** — Python modules in `custom_indicators/` appear in the chart Custom menu
- **Correlation Density** — pair scan, pair-detail charts, live hedge quotes
- **Option analysis** — option chain, open interest, gamma exposure, strategy builder (needs Dhan or 5Paisa)
- **Settings** — brokers, markets, intervals, option-chain columns, indicators, optional public API
- **Public API** — optional CORS endpoints under `/public/api/` for status, 5Paisa search/chart/historical, and TA catalog
- **LAN / iPhone** — binds to `0.0.0.0` by default so devices on the same Wi-Fi can open the UI

## Requirements

- Windows, macOS, or Linux
- Python 3.10 or newer (including 3.14). Python 3.6 is not supported.
- On Windows a local copy can be installed into `python314` with `Win Startup/install_python.bat`. On macOS run `MAC Startup/setup_mac.sh` or install from python.org.

## Quick Start (Windows)

1. Open the project folder.
2. Run `Win Startup\install_python.bat` if you do not already have Python 3.10+.
3. Run `Win Startup\install_libs.bat` to install dependencies into `App\libs` (required after upgrading Python).
4. Run `Win Startup\start_server.bat`.
5. Open the URL shown in the terminal: http://127.0.0.1:5000/

## Quick Start (macOS / Linux)

1. Open Terminal in the project folder.
2. Run `./"MAC Startup"/setup_mac.sh` if you do not already have Python 3.10+ (installs via Homebrew on macOS).
3. Run `./"MAC Startup"/install_libs.sh` to install dependencies into `App/libs`.
4. Run `./"MAC Startup"/start_server.sh`.

## Use from iPhone / iPad

- The server binds to `0.0.0.0` by default, so any device on the same Wi-Fi can open it.
- After starting, use the **iPhone/iPad (same Wi-Fi)** URL printed in the terminal (e.g. `http://192.168.1.23:5000/`) in Safari.
- For a full-screen, app-like experience: Safari **Share → Add to Home Screen**.
- To restrict the server to localhost: `TRADERAPP_HOST=127.0.0.1 "./MAC Startup/start_server.sh"` (same env var works on Windows).
- Port override: `TRADERAPP_PORT=5001`.

## Using the app

1. Open **Connect to Broker** and enable/connect Dhan, 5Paisa, Yahoo, or Excel.
2. On **Home**, pick a broker tab, search a symbol, choose an interval, and click **Load**.
3. Use the **Watchlist** button in the chart toolbar to dock a watchlist; add symbols with **+**, and click a row to load it. When a symbol is selected, a **News** panel appears below the watchlist (for Dhan, 5Paisa, and Yahoo).
4. Under **Analysis**:
   - **Correlation** — scan pairs and open pair-detail (normalized prices, ratio, density, rolling correlation, z-score).
   - **Option Chain / Open Interest / Gamma Exposure / Strategy Builder** — available when Dhan or 5Paisa is connected.
5. **Settings** — market filters, chart intervals, option-chain fields, indicators, and optional API access.

Credentials and tokens are stored locally by the app. Do not commit `credentials` files, `.flask_secret`, or similar secrets.

## Stock news

When a symbol is selected on the Home chart (Dhan, 5Paisa, or Yahoo), the watchlist shows a **News** panel with recent headlines. News is fetched through the Yahoo Finance module in `broker/yahoo.py`:

- Primary source is **yfinance** (`yfinance.Ticker(symbol).news`).
- Falls back to **Google News RSS** keyed off the instrument name when yfinance returns nothing — this is what delivers relevant headlines for Indian (`.NS`/`.BO`) symbols, since Yahoo's news endpoints are US-centric and rate-limited.

## Public API

Disabled until **API access** is turned on in Settings. Endpoints include:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/public/api/status` | Connection status |
| GET | `/public/api/ta/catalog` | Built-in and custom indicator catalog |
| GET | `/public/api/5paisa/search?q=` | Instrument search |
| POST | `/public/api/5paisa/chart` | Chart candles |
| GET | `/public/api/5paisa/historical` | Historical series (optional `TA=true`) |

5Paisa must be connected for search/chart/historical calls.

## Project layout

```
App/                   Flask app and runtime files
  app.py               Flask app, Socket.IO, routes
  broker/              Dhan, 5Paisa, Yahoo, Excel adapters
  analysis/            Correlation density, pair detail, stats helpers
  services/            Scans, market data, option chain, OI, GEX, intervals
  custom_indicators/   Drop-in Python indicators (META + compute)
  templates/           Web UI
  static/              CSS and JS
  libs/                Bundled pip packages (same Python version as the runtime)
  datafeed/            Optional cached CSVs when save-to-datafeed is on
Win Startup/           Windows start and install scripts
MAC Startup/           macOS/Linux start and install scripts
```

## Notes

- The Excel broker (`xlwings`) works on Windows and macOS. On macOS, Microsoft Excel for Mac must be installed; COM (`pywin32`) is used on Windows only.
- The app uses `App/libs` for bundled Python packages. Install those packages with the same Python version that runs the app.
- An old `python36` folder can be deleted if you no longer need it.
- Broker modules load best-effort: a broken or offline broker does not block the rest of the app from starting.
