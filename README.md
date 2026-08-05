# Dividr

A powerful video editing application built with Electron and FFmpeg.

## Prerequisites

Before setting up the project, ensure you have the following installed:

- **Node.js** (v18 or higher)
- **yarn** or **yarn**
- **Python** (v3.8 or higher, recommended: Python 3.13)
- **Git**

## Getting Started

### 1. Clone the Repository

```bash
git clone <repository-url>
cd dividr-ui
```

### 2. Install Node.js Dependencies

```bash
yarn install
```

### 3. Set Up Python Transcription Environment

The application uses `faster-whisper` for audio transcription. Follow these steps to set up the Python environment:

#### For Development Mode

The app looks for a virtual environment at `src/backend/python/venv` first and only falls back to whatever `python` is on your PATH. Set up the venv so you get an isolated, known-good environment:

1. **Create the venv and install dependencies:**

   ```bash
   py -3.13 -m venv src/backend/python/venv
   src/backend/python/venv/Scripts/pip install -r requirements.txt
   ```

   (macOS/Linux: `python3 -m venv src/backend/python/venv && src/backend/python/venv/bin/pip install -r requirements.txt`)

2. **Verify installation:**

   ```bash
   src/backend/python/venv/Scripts/python src/backend/python/scripts/transcribe.py --help
   ```

   You should see the help message for the transcription script.

Without the venv, the app silently falls back to your system Python — that works only if it has everything in `requirements.txt` installed (`pip install -r requirements.txt`), and version conflicts with other projects are on you.

#### For Build/Production Version

When building the application for distribution, ensure Python dependencies are installed on the target system:

1. **Include requirements.txt in your build** (already configured in the project)

2. **On the target system, install Python dependencies:**

   ```bash
   pip install -r requirements.txt
   ```

3. **The application will look for the transcribe.py script at:**
   - Development: `src/backend/python/scripts/transcribe.py`
   - Production: `resources/backend/python/scripts/transcribe.py` (bundled in the build)

#### Python Dependencies

The transcription feature requires:

- `faster-whisper>=1.0.0` - Optimized Whisper implementation
- `torch==2.8.0` - PyTorch (CPU version, required for DeepFilterNet compatibility)

For GPU acceleration, install the CUDA-enabled version of PyTorch:

```bash
pip install torch==2.8.0

```

## Development

### Running the Application

```bash
yarn start
```

This will start the Electron application in development mode with hot-reloading.

### Building the Application

To package the application for distribution:

```bash
yarn run package
```

To create installers:

```bash
yarn run make
```

### Project Structure

```
dividr-ui/
├── src/
│   ├── backend/
│   │   ├── python/
│   │   │   ├── main.py          # Python multi-tool entry point
│   │   │   └── scripts/
│   │   │       ├── transcribe.py    # Python transcription script
│   │   │       └── noisereduction.py # Noise reduction script
│   │   └── whisper/              # Whisper transcription runners
│   ├── frontend/                # React frontend code
│   └── main.ts                  # Electron main process
├── requirements.txt             # Python dependencies
├── package.json                 # Node.js dependencies
└── README.md
```

## Features

- Video editing with FFmpeg
- AI-powered transcription using Faster-Whisper
- Real-time preview
- Timeline-based editing
- Export to various formats

## Troubleshooting

### Transcription Issues

If you encounter issues with transcription:

1. **Check Python installation:**

   ```bash
   python --version
   ```

2. **Verify faster-whisper is installed:**

   ```bash
   pip list | grep faster-whisper
   ```

3. **Test the transcription script manually:**
   ```bash
   python src/backend/python/scripts/transcribe.py --help
   ```
