# DCX Testnet Replicator

The **DCX Testnet Replicator** is a high-performance market synchronization and simulation engine. It is designed to bridge live market data (e.g., Binance) to the DCX Testnet Futures environment. By algorithmically managing Maker and Taker accounts, the replicator maintains a synchronized orderbook and trade history, facilitating realistic market conditions on the testnet for reliable testing and scenario simulation.

---

## 🌟 Key Features

- **Orderbook & Trade Synchronization:** Automatically replicates deep market data from source exchanges into the testnet environment.
- **Advanced Scenario Engine:** Inject synthetic market anomalies like Flash Crashes or Partial Liquidations to test downstream system resilience.
- **Dynamic Configuration Drawer:** A premium, glassmorphism-styled UI that allows you to manage markets, scale parameters, and toggle execution controls in real-time.
- **Auto-Account Generation:** Seamlessly spin up new testnet user credentials on the fly directly from the UI.
- **Real-time Terminal & Portfolio Views:** Monitor live logs, API payloads, open orders, and historical trades via real-time WebSocket and SSE streams.
- **Execution Controls:** Tune order delays, quantity buffers, and cancellation strategies on stop.

---

## 🏗 Architecture

The project employs a robust monolithic structure designed for immediate execution and minimal deployment friction:

1. **`replicator.js` (Backend):**
   - A single-file Node.js server that handles the core replication loops.
   - Manages WebSocket connections to both the source exchange and the testnet.
   - Computes state differentials and issues fast execution orders to maintain the orderbook.
   - Serves an API and Server-Sent Events (SSE) stream for real-time frontend updates.

2. **`index.html` (Frontend):**
   - A comprehensive, single-page application built with Vanilla JS, CSS3, and HTML5.
   - Features a high-fidelity glassmorphism UI with both Dark and Light themes.
   - Implements zero-dependency state management and custom components (e.g., custom select dropdowns, toggles).
   - Injects real-time terminal logs merging both backend processes and client-side WebSocket events.

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v16+ recommended)
- npm

### Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Configuration setup:
   - Make sure your local `.env` and `config.json` files are properly configured.
   - *Note: These files are ignored in version control for security.*

### Running the Application

Start the replicator engine:
```bash
node replicator.js
```
*Alternatively, you can use a process manager like PM2 (`pm2 start replicator.js`) to run the engine in the background.*

Once running, navigate to:
```
http://localhost:3000
```
to access the Replicator Dashboard.

---

## 🛠 Configuration Details

### `config.json`
Defines your primary target markets, default sizing, and execution strategies.
```json
{
  "symbol": "BTCUSDT",
  "targetSymbol": "BTCQAUSDT",
  "scaling": {
    "minSize": 100,
    "maxSize": 1000,
    "depthLevels": 10,
    "bufferPct": 0.5,
    "cancelOnStop": true
  }
}
```

### `multi-config.json`
Allows you to declare an array of configurations to run multiple synchronization pairs simultaneously.

---

## 🧪 Advanced Scenarios

The included **Scenario Engine** is accessible via the frontend drawer. You can manually trigger templates such as:
- **Flash Crash:** Drops the market price artificially by 10% momentarily.
- **Partial Liquidation:** Simulates significant spread volatility targeting forced liquidations.

---

## 📁 Repository Structure

- `replicator.js`: Core Node.js backend.
- `index.html`: Web-based dashboard UI.
- `scripts/`: Helper scripts (e.g., `generate-single.js` for automated user provisioning).
- `package.json`: Project dependencies and metadata.

---

## 🤝 Contributing
For frontend optimizations, `index.html` encompasses all styles and scripts. When implementing changes, ensure UI responsiveness and preserve the exact color palettes (specifically the exact `z-index` stacking hierarchy in the drawer components) and maintain the premium View Transitions.

---
*Developed for internal DCX Testnet scaling and simulation.*
