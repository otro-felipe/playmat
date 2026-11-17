import { readJson, writeJson } from '../stores/persist';

const hideGuideKey = 'playmat.hideMcpConnectionGuide';

export function mcpConnectionGuideHidden() {
  return readJson<boolean>(hideGuideKey, false) === true;
}

export function saveMcpConnectionGuidePreference(hidden: boolean) {
  writeJson(hideGuideKey, hidden);
}

export function mcpEndpoint() {
  return `${window.location.origin}/mcp`;
}
