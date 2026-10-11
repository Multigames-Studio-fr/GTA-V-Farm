# 🚀 Installation Guide – MacroEngine

## Quick Install (Recommended)

### Windows 10/11 (64-bit)

1. **Download** `MacroEngine-Setup-<version>.exe` from [Releases](https://github.com/Multigames-Studio-fr/GTA-V-Farm/releases)
2. **Run** the installer
3. **Follow** the setup wizard
4. **Launch** from Start Menu → "MacroEngine"
5. ✅ **Done!** Auto-updates enabled

---

## Advanced Installation

### Portable Version (No Installation)

Perfect for USB drives or testing:

1. Download `MacroEngine-Portable-<version>.exe`
2. Place in any folder (e.g., `C:\Tools\MacroEngine\`)
3. Run it directly – no installation needed
4. First launch extracts ~200MB of dependencies

### Build from Source

Requires: Node.js 16+, Python 3.11+

```bash
# Clone
git clone https://github.com/Multigames-Studio-fr/GTA-V-Farm.git
cd "GTA V FARM"

# Install dependencies
cd electron-app
npm install

# Run in dev mode
npm run dev

# Build installer
npm run build-nsis

# Build portable exe
npm run build-portable
```

Built files are in `electron-app/dist/`.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Administrator required" | Right-click installer → Run as Administrator |
| Won't start | Uninstall, then reinstall in Program Files |
| Still crashes | Delete `%APPDATA%\MacroEngine`, reinstall |
| On USB drive | Use Portable version instead |

---

## Next Steps

1. Open MacroEngine
2. Read the **Quick Start** in-app guide
3. Create your first macro!
4. Check [FAQ](https://github.com/Multigames-Studio-fr/GTA-V-Farm/discussions) for common questions

---

**Need help?** Open an [Issue](https://github.com/Multigames-Studio-fr/GTA-V-Farm/issues) or [Discussion](https://github.com/Multigames-Studio-fr/GTA-V-Farm/discussions)
