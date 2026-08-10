// import { MakerPKG } from '@electron-forge/maker-pkg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack:
        '**/node_modules/{@ffmpeg-installer,ffmpeg-static,ffprobe-static}/**/*',
    },
    icon: './favicon.ico',
    name: 'DiviDr',
    executableName: 'diviDr',
    extraResource: [
      './src/frontend/assets/logo',
      './src/backend/python/scripts',
      './src/backend/ffmpeg/ffmpeg-model',
      // yt-dlp, so b-roll sourcing works on a machine that never installed it.
      // Populated by the generateAssets hook below; main.ts self-heals a stale
      // or missing copy into userData at runtime.
      './ytdlp-bin',
      // dividr-tools is now downloaded on-demand from GitHub Releases
      // to reduce installer size from ~1.3GB to ~200MB
    ],
    // macOS code signing - uses APPLE_IDENTITY env variable
    ...(process.env.APPLE_IDENTITY && {
      osxSign: {
        identity: process.env.APPLE_IDENTITY,
        optionsForFile: () => ({
          hardenedRuntime: true,
          entitlements: './entitlements.plist',
          'entitlements-inherit': './entitlements.plist',
        }),
      },
    }),
    ignore: [
      // Git and docs
      /^\/\.gitignore$/,
      /^\/\.git\//,
      /^\/README\.md$/,
      /^\/docs\//,

      // Large binary directories (not packaged with app)
      /^\/ffmpeg-bin\//,
      /^\/dividr-tools-bin\//,
      /^\/build\//,

      // Python environment (user must install separately)
      /^\/venv\//,
      /^\/\.venv\//,
      /^\/env\//,
      /^\/\.env\//,
      // .env FILES (API keys) — the pattern above only matches a .env directory
      /^\/\.env(\..*)?$/,
      /^\/requirements\.txt$/,
      /^\/setup-python\.(bat|sh)$/,
      // Python venv inside src/backend/python (development only)
      /^\/src\/backend\/python\/venv\//,
      /^\/src\/backend\/python\/\.venv\//,
      /^\/src\/backend\/python\/dividr-tools-bin\//,
      /^\/src\/backend\/python\/.*\.zip$/,

      // Public assets that aren't needed in production
      /^\/public\/sprite-sheets\//,
      /^\/public\/thumbnails\//,

      // Test files
      /\.test\.(ts|tsx|js|jsx)$/,
      /\.spec\.(ts|tsx|js|jsx)$/,
      /__tests__\//,
      // Test suites, fixtures (personal recordings), and results
      /^\/tests\//,
      /^\/test-results\//,

      // Prior build output and stray dev scripts
      /^\/out\//,
      /^\/dist\//,
      /^\/shot-card\.mjs$/,

      // yt-dlp ships via extraResource — keep it out of the asar so it isn't
      // packaged twice (18MB) and stays spawnable as a plain file on disk.
      /^\/ytdlp-bin\//,

      // Source maps in production
      /\.map$/,
    ],
  },
  rebuildConfig: {},
  hooks: {
    // `make`/`package` have no prestart, so fetch yt-dlp here or the installer
    // ships without it. The script is a no-op when the copy is under a fortnight
    // old and never fails the build.
    generateAssets: async () => {
      const { spawnSync } = await import('node:child_process');
      const script = path.resolve(__dirname, 'scripts', 'download-ytdlp.mjs');
      spawnSync(process.execPath, [script], { stdio: 'inherit' });
    },
  },
  makers: [
    // Windows NSIS installer.
    // NOTE: this maker only reads `codesign`, `updater`, and
    // `getAppBuilderConfig` — everything else must go through the
    // electron-builder config returned below (absolute paths: the builder
    // runs from a temp copy of the packaged app, not the repo root).
    {
      name: '@felixrieseberg/electron-forge-maker-nsis',
      config: {
        getAppBuilderConfig: async () => ({
          productName: 'DiviDr',
          win: {
            icon: path.resolve(__dirname, 'favicon.ico'),
          },
          nsis: {
            oneClick: false,
            perMachine: false,
            allowToChangeInstallationDirectory: true,
            installerIcon: path.resolve(__dirname, 'favicon.ico'),
            uninstallerIcon: path.resolve(__dirname, 'favicon.ico'),
            runAfterFinish: true,
            createDesktopShortcut: true,
            createStartMenuShortcut: true,
            shortcutName: 'DiviDr',
            deleteAppDataOnUninstall: false,
            // Custom NSIS script for .dividr file associations
            include: path.resolve(__dirname, 'installer.nsh'),
          },
        }),
      },
    },

    // Cross-platform ZIP packages
    new MakerZIP({}, ['darwin', 'win32', 'linux']),

    // Linux DEB package (Debian/Ubuntu)
    new MakerDeb({
      options: {
        name: 'dividr',
        productName: 'Dividr',
        genericName: 'Video Editor',
        description:
          'A powerful video editing application built with Electron and FFmpeg',
        maintainer: 'Dividr Team <dividr@gmail.com>',
        homepage: 'https://github.com/talisik-ai/dividr',
        icon: './favicon.ico',
        categories: ['AudioVideo', 'Video', 'AudioVideoEditing'],
      },
    }),

    // Linux RPM package (Fedora/RHEL/CentOS)
    new MakerRpm({
      options: {
        name: 'dividr',
        productName: 'Dividr',
        genericName: 'Video Editor',
        description:
          'A powerful video editing application built with Electron and FFmpeg',
        homepage: 'https://github.com/talisik-ai/dividr',
        icon: './favicon.ico',
        categories: ['AudioVideo', 'Video', 'AudioVideoEditing'],
      },
    }),
  ],

  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
