import { defineConfig } from 'wxt';
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Briefly',
    version: '2.0.0',
    description: 'A persistent YouTube research copilot with local memory, chat, and bring-your-own API keys.',
    permissions: [
      'activeTab',
      'alarms',
      'scripting',
      'storage',
      'unlimitedStorage',
      'sidePanel',
      'tabs',
      'webNavigation',
      'declarativeNetRequest',
      'declarativeNetRequestWithHostAccess',
    ],
    host_permissions: [
      '*://*.youtube.com/*',
      '*://youtu.be/*',
      'https://api.openai.com/*',
      'https://api.anthropic.com/*',
      'https://generativelanguage.googleapis.com/*',
    ],
    action: {
      default_title: 'Open Briefly',
    },
    icons: {
      16: 'icons/briefly-16.png',
      48: 'icons/briefly-48.png',
      128: 'icons/briefly-128.png',
    },
    declarative_net_request: {
      rule_resources: [
        {
          id: 'youtube_origin_rules',
          enabled: true,
          path: 'youtube-origin-rules.json',
        },
      ],
    },
    web_accessible_resources: [
      {
        resources: ['youtube-bridge.js'],
        matches: ['*://*.youtube.com/*'],
      },
    ],
  },
});
