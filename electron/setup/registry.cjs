/**
 * Declarative component registry for the Setup tab.
 *
 * This file is the single source of truth for both the renderer (names,
 * groups, blurbs, icons) and the installer (probe/install commands per OS).
 * Nothing here executes anything: electron/setup/detect.cjs and
 * electron/setup/install.cjs consume these arrays.
 *
 * A command is always `{ bin, args, sudo? }`. Tuple form `["git", "--version"]`
 * is accepted and normalized at load time so the tables stay readable.
 */

const platforms = ["win", "linux", "mac"];

const COMPONENTS = [
  {
    id: "python",
    name: "Python",
    group: "runtime",
    icon: "python",
    blurb: "Интерпретатор Python 3, pip и venv — основа для скриптов и агентов.",
    dependsOn: [],
    manualUrl: "https://www.python.org/downloads/",
    check: {
      win: [
        ["py", "-3", "--version"],
        ["python", "--version"],
        ["python3", "--version"],
      ],
      linux: [
        ["python3", "--version"],
        ["python", "--version"],
      ],
      mac: [
        ["python3", "--version"],
        ["python", "--version"],
      ],
    },
    version: {
      win: [
        ["py", "-3", "--version"],
        ["python", "--version"],
      ],
      linux: [["python3", "--version"]],
      mac: [["python3", "--version"]],
    },
    install: {
      win: [
        {
          bin: "winget",
          args: [
            "install",
            "-e",
            "--id",
            "Python.Python.3.12",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--silent",
          ],
        },
        { bin: "choco", args: ["install", "python", "-y", "--no-progress"] },
      ],
      linux: [
        { bin: "apt-get", args: ["install", "-y", "python3", "python3-pip", "python3-venv"], sudo: true },
        { bin: "dnf", args: ["install", "-y", "python3", "python3-pip"], sudo: true },
        { bin: "pacman", args: ["-S", "--noconfirm", "python", "python-pip"], sudo: true },
        { bin: "zypper", args: ["install", "-y", "python3", "python3-pip"], sudo: true },
      ],
      mac: [{ bin: "brew", args: ["install", "python@3.12"] }],
    },
    fallback: {
      win: {
        url: "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe",
        file: "python-3.12.7-amd64.exe",
        args: ["/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_pip=1"],
      },
    },
  },
  {
    id: "git",
    name: "Git",
    group: "tool",
    icon: "git",
    blurb: "Система контроля версий: git-панель, авто-коммиты и работа агента с репозиторием.",
    dependsOn: [],
    manualUrl: "https://git-scm.com/downloads",
    check: {
      win: [["git", "--version"]],
      linux: [["git", "--version"]],
      mac: [["git", "--version"]],
    },
    version: {
      win: [["git", "--version"]],
      linux: [["git", "--version"]],
      mac: [["git", "--version"]],
    },
    install: {
      win: [
        {
          bin: "winget",
          args: [
            "install",
            "-e",
            "--id",
            "Git.Git",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--silent",
          ],
        },
        { bin: "choco", args: ["install", "git", "-y", "--no-progress"] },
      ],
      linux: [
        { bin: "apt-get", args: ["install", "-y", "git"], sudo: true },
        { bin: "dnf", args: ["install", "-y", "git"], sudo: true },
        { bin: "pacman", args: ["-S", "--noconfirm", "git"], sudo: true },
        { bin: "zypper", args: ["install", "-y", "git"], sudo: true },
      ],
      mac: [{ bin: "brew", args: ["install", "git"] }],
    },
    fallback: {
      win: {
        // git-scm.com/download/win redirects to the current official 64-bit installer.
        url: "https://git-scm.com/download/win",
        file: "Git-64-bit.exe",
        // Inno Setup: silent, no restart, no cancel prompt.
        args: ["/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-"],
      },
    },
  },
  {
    id: "blender",
    name: "Blender",
    group: "3d",
    icon: "blender",
    blurb: "3D-редактор для Blender-плагина: сцены, PBR-материалы, рендеры и игровые экспорты.",
    dependsOn: [],
    manualUrl: "https://www.blender.org/download/",
    check: {
      win: [["blender", "--version"]],
      linux: [["blender", "--version"]],
      mac: [["blender", "--version"]],
    },
    version: {
      win: [["blender", "--version"]],
      linux: [["blender", "--version"]],
      mac: [["blender", "--version"]],
    },
    install: {
      win: [
        {
          bin: "winget",
          args: [
            "install",
            "-e",
            "--id",
            "BlenderFoundation.Blender",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--silent",
          ],
        },
        { bin: "choco", args: ["install", "blender", "-y", "--no-progress"] },
      ],
      linux: [
        { bin: "apt-get", args: ["install", "-y", "blender"], sudo: true },
        { bin: "dnf", args: ["install", "-y", "blender"], sudo: true },
        { bin: "pacman", args: ["-S", "--noconfirm", "blender"], sudo: true },
      ],
      mac: [{ bin: "brew", args: ["install", "--cask", "blender"] }],
    },
    fallback: {
      win: {
        // Pinned LTS build on the permanent Blender mirror; winget/choco are preferred.
        url: "https://download.blender.org/release/Blender4.2/blender-4.2.3-windows-x64.exe",
        file: "blender-4.2.3-windows-x64.exe",
        // NSIS: /S must stay first and /D last, unquoted, or the flags are ignored.
        args: ["/S"],
      },
    },
  },
  {
    id: "go",
    name: "Go",
    group: "runtime",
    icon: "go",
    blurb: "Компилятор и тулчейн Go — для сборки Go-проектов и утилит.",
    dependsOn: [],
    manualUrl: "https://go.dev/dl/",
    check: {
      win: [["go", "version"]],
      linux: [["go", "version"]],
      mac: [["go", "version"]],
    },
    version: {
      win: [["go", "version"]],
      linux: [["go", "version"]],
      mac: [["go", "version"]],
    },
    install: {
      win: [
        {
          bin: "winget",
          args: [
            "install",
            "-e",
            "--id",
            "GoLang.Go",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--silent",
          ],
        },
        { bin: "choco", args: ["install", "golang", "-y", "--no-progress"] },
      ],
      linux: [
        { bin: "apt-get", args: ["install", "-y", "golang-go"], sudo: true },
        { bin: "dnf", args: ["install", "-y", "golang"], sudo: true },
        { bin: "pacman", args: ["-S", "--noconfirm", "go"], sudo: true },
        { bin: "zypper", args: ["install", "-y", "go"], sudo: true },
      ],
      mac: [{ bin: "brew", args: ["install", "go"] }],
    },
    fallback: {
      win: {
        url: "https://go.dev/dl/go1.23.4.windows-amd64.msi",
        file: "go1.23.4.windows-amd64.msi",
        args: ["/quiet", "/norestart"],
      },
    },
  },
  {
    id: "rust",
    name: "Rust",
    group: "runtime",
    icon: "rust",
    blurb: "rustup + cargo: компилятор Rust и менеджер тулчейнов.",
    dependsOn: [],
    manualUrl: "https://rustup.rs",
    check: {
      win: [["rustc", "--version"], ["cargo", "--version"], ["rustup", "--version"]],
      linux: [["rustc", "--version"], ["cargo", "--version"], ["rustup", "--version"]],
      mac: [["rustc", "--version"], ["cargo", "--version"], ["rustup", "--version"]],
    },
    version: {
      win: [["rustc", "--version"], ["cargo", "--version"]],
      linux: [["rustc", "--version"], ["cargo", "--version"]],
      mac: [["rustc", "--version"], ["cargo", "--version"]],
    },
    install: {
      win: [
        {
          bin: "winget",
          args: [
            "install",
            "-e",
            "--id",
            "Rustlang.Rustup",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--silent",
          ],
        },
        { bin: "choco", args: ["install", "rustup.install", "-y", "--no-progress"] },
      ],
      linux: [{ bin: "brew", args: ["install", "rustup"] }],
      mac: [{ bin: "brew", args: ["install", "rustup"] }],
    },
    fallback: {
      win: {
        url: "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe",
        file: "rustup-init.exe",
        args: ["-y", "--no-modify-path"],
      },
      linux: {
        // Official rustup script, saved first, then executed locally — never curl | sh.
        url: "https://sh.rustup.rs",
        file: "rustup-init.sh",
        run: "sh",
        args: ["-y", "--no-modify-path"],
      },
      mac: {
        url: "https://sh.rustup.rs",
        file: "rustup-init.sh",
        run: "sh",
        args: ["-y", "--no-modify-path"],
      },
    },
  },
  {
    id: "websearch",
    name: "Веб-поиск",
    group: "search",
    icon: "search",
    blurb: "Агент веб-поиска: использует Python и Git, обновляет pip/setuptools/wheel.",
    dependsOn: ["python", "git"],
    requires: ["git"],
    manualUrl: "https://pip.pypa.io/en/stable/installation/",
    check: {
      win: [
        ["python", "-c", "import pip"],
        ["python", "-m", "pip", "--version"],
        ["py", "-3", "-m", "pip", "--version"],
      ],
      linux: [
        ["python3", "-m", "pip", "--version"],
        ["python", "-m", "pip", "--version"],
      ],
      mac: [
        ["python3", "-m", "pip", "--version"],
        ["python", "-m", "pip", "--version"],
      ],
    },
    version: {
      win: [["python", "-m", "pip", "--version"]],
      linux: [["python3", "-m", "pip", "--version"]],
      mac: [["python3", "-m", "pip", "--version"]],
    },
    prepare: "pip",
    install: { win: [], linux: [], mac: [] },
  },
];

function normalizeCommand(spec) {
  if (Array.isArray(spec)) {
    const [bin, ...args] = spec;
    return { bin: String(bin), args: args.map(String) };
  }
  if (!spec || typeof spec !== "object" || !spec.bin) return null;
  return {
    bin: String(spec.bin),
    args: Array.isArray(spec.args) ? spec.args.map(String) : [],
    sudo: spec.sudo === true,
  };
}

function mapPlatform(table, mapper) {
  const out = {};
  for (const plat of platforms) {
    const list = Array.isArray(table?.[plat]) ? table[plat] : [];
    out[plat] = list.map(mapper).filter(Boolean);
  }
  return out;
}

for (const component of COMPONENTS) {
  component.platforms = platforms.slice();
  component.dependsOn = Array.isArray(component.dependsOn) ? component.dependsOn : [];
  component.requires = Array.isArray(component.requires) ? component.requires : [];
  component.check = mapPlatform(component.check, normalizeCommand);
  component.version = mapPlatform(component.version, normalizeCommand);
  component.install = mapPlatform(component.install, normalizeCommand);
}

const BY_ID = new Map(COMPONENTS.map((component) => [component.id, component]));

function getComponent(id) {
  return BY_ID.get(String(id || "")) || null;
}

function componentIds() {
  return COMPONENTS.map((component) => component.id);
}

/**
 * Build the renderer payload from persisted state. Unknown ids can never leak
 * into the UI because the list is driven by COMPONENTS, not by the state file.
 */
function toPublic(state) {
  const stored = state && state.components && typeof state.components === "object" ? state.components : {};
  return COMPONENTS.map((component) => {
    const entry = stored[component.id] || {};
    return {
      id: component.id,
      name: component.name,
      group: component.group,
      blurb: component.blurb,
      icon: component.icon,
      platformSupport: component.platforms.slice(),
      dependsOn: component.dependsOn.slice(),
      manualUrl: component.manualUrl || null,
      installed: entry.installed === true,
      version: typeof entry.version === "string" ? entry.version : null,
      path: typeof entry.path === "string" ? entry.path : null,
      method: typeof entry.method === "string" ? entry.method : null,
      lastError: typeof entry.lastError === "string" ? entry.lastError : null,
      lastCheckAt: Number.isFinite(entry.lastCheckAt) ? entry.lastCheckAt : 0,
    };
  });
}

module.exports = { COMPONENTS, platforms, getComponent, componentIds, toPublic };
