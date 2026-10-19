# VoxOverlay 🎙️⚡

> High-performance local neural TTS daemon & zero-reflow word-level reading overlay for Chromium browsers (Brave, Chrome, Edge, Arc).

VoxOverlay pairs a fast local Python daemon powered by **FastAPI**, **Kokoro-82M ONNX**, and **PyMuPDF** with a modern **Manifest V3 browser extension**. It provides instantaneous, natural-sounding voice synthesis with synchronized word and paragraph highlighting using Chromium's **CSS Custom Highlight API** (::highlight(vox-word))—without altering or reflowing the webpage DOM.

---

## ✨ Features

- **Local Neural Voice (Kokoro-82M)**: 82-million parameter neural TTS running fully offline with hardware acceleration (DirectML on Windows, CUDA, or multi-threaded CPU).
- **Zero-Reflow Word Highlighting**: Utilizes the modern Chromium CSS.highlights API to paint highlight layers over words and paragraphs dynamically without wrapping text nodes in <span> tags.
- **Pipelined WebSocket Streaming**: Full-duplex WebSocket (ws://127.0.0.1:8765/ws/tts) with look-ahead sentence caching for gapless audio playback.
- **Instant Speed Modulation (0.5x – 3.0x)**: Pitch-preserving WSOLA time stretching that adjusts mid-sentence in real time without triggering re-synthesis.
- **Click-to-Read (Alt + Click)**: Hold Alt and click any paragraph on the page to immediately start reading from that point downward.
- **Integrated PDF Reader**: Clean paragraph extraction for web and local PDFs using PyMuPDF.

---

## 📁 Repository Structure

```
voxoverlay/
├── ext/                   # Chromium Manifest V3 browser extension
│   ├── manifest.json      # Extension manifest
│   ├── background.js      # Service worker (shortcuts & context menus)
│   └── content.js         # HUD UI, audio pipeline, & CSS highlight engine
├── models/                # Kokoro ONNX model weights (auto-downloaded on first run)
├── requirements.txt       # Python dependencies
├── server.py              # FastAPI server & Kokoro TTS inference engine
└── README.md
```

---

## 🚀 Part 1: Local Server Setup

### 1. Prerequisites
- **Python**: 3.10 to 3.14 (64-bit recommended).
- **Operating System**: Windows 10/11, Linux, or macOS.

### 2. Set Up Virtual Environment

Open your terminal in the project directory:

#### **Windows (PowerShell)**:
`powershell
# Create virtual environment
python -m venv .venv

# Activate virtual environment
.\.venv\Scripts\Activate.ps1

# Upgrade pip and install dependencies
pip install --upgrade pip
pip install -r requirements.txt
`

> **Note for PowerShell execution policy**: If script execution is restricted, run:
> `powershell
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
> `

#### **Linux / macOS**:
`ash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
`

### 3. Start the Server

Run:
`powershell
python server.py
`

- On the very first run, the server will **automatically download** the Kokoro-82M ONNX model (kokoro-v1.0.onnx, ~325 MB) and voice weights (oices-v1.0.bin, ~28 MB) directly into the ./models directory.
- The server will boot on http://127.0.0.1:8765.
- You can verify the health endpoint by visiting:
  `
  http://127.0.0.1:8765/api/health
  `

---

## 🌐 Part 2: Install Extension in Any Chromium Browser

The extension works on any Chromium-based browser, including **Brave**, **Google Chrome**, **Microsoft Edge**, **Arc**, **Vivaldi**, and **Opera**.

### Step-by-Step Installation:

1. **Open the Extensions page** in your browser:
   - **Brave**: Navigate to rave://extensions
   - **Chrome**: Navigate to chrome://extensions
   - **Edge**: Navigate to edge://extensions
   - **Arc / Opera / Vivaldi**: Open Settings -> Extensions

2. **Enable Developer Mode**:
   - Look for the **Developer mode** toggle in the top-right corner (or sidebar on Edge) and switch it **ON**.

3. **Load Unpacked Extension**:
   - Click the **Load unpacked** button in the top menu.
   - In the file dialog, navigate into the project directory and select the **ext** folder:
     `
     voxoverlay/ext
     `
   - Click **Select Folder**.

4. **Verify Installation**:
   - You will see **VoxOverlay — Local Neural TTS & Word Highlighter** appear in your extension list.
   - (Recommended) Click the puzzle piece / extensions icon on your browser toolbar and **pin** VoxOverlay for quick access.

5. **Allow Access to File URLs (Optional, for reading local PDFs)**:
   - In rave://extensions (or chrome://extensions), click **Details** on the VoxOverlay card.
   - Toggle **Allow access to file URLs** to **ON**. This allows VoxOverlay to read local .pdf files opened in the browser.

---

## 🎮 How to Use

| Action | Shortcut / Method | Description |
| :--- | :--- | :--- |
| **Toggle HUD** | Alt + R (or click toolbar icon) | Opens or hides the floating VoxOverlay player. |
| **Play / Pause** | Alt + Space (or HUD Play button) | Toggles playback of current article/selection. |
| **Click to Read** | Alt + Click on any paragraph | Immediately jumps and begins reading from that block. |
| **Read Selection** | Select text -> Right-click -> *Read aloud with VoxOverlay* | Reads only the highlighted selection. |
| **Change Voice** | HUD Voice Dropdown | Switch between US/UK male and female neural voices. |
| **Adjust Speed** | HUD Speed Slider (.5x - 3.0x) | Adjusts reading speed in real time without pausing. |
| **Pick Mode** | HUD "Pick Paragraph" button | Activates crosshair cursor to choose a start point. |

---

## 🔧 Technical Details

- **FastAPI Daemon**: Asynchronous server with WebSocket streaming and PyMuPDF layout-aware paragraph extraction.
- **Kokoro-82M ONNX**: Highly expressive text-to-speech engine running via ONNX Runtime with DirectML hardware acceleration.
- **CSS Custom Highlight API**: Zero layout thrashing / reflows. Highlighting works by positioning ranges in browser memory rather than injecting markup into the document DOM.
- **WSOLA Time-Stretching**: Real-time tempo scaling preserving audio pitch via HTML5 Media element WSOLA algorithm.
