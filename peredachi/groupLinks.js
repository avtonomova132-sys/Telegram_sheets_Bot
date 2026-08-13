const fs = require('fs');
const path = require('path');

// /data — тот же примонтированный Railway Volume, что и /data/peredachi.json.
const GROUP_LINKS_PATH = process.env.GROUP_LINKS_PATH || '/data/group-links.json';

// Внутренние ссылки вида https://t.me/c/<id>/<номер сообщения> не открываются
// у тех, кто не состоит в группе — их нужно подменять на пригласительные.
const SEED_DATA = { '3698510352': 'https://t.me/+Va-z6dHKYT81OWVk' };

function readGroupLinks() {
  try {
    const data = JSON.parse(fs.readFileSync(GROUP_LINKS_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[group-links] volume недоступен или файл повреждён, читаю как пустой список:', err.message);
    }
    return {};
  }
}

function writeGroupLinks(map) {
  fs.mkdirSync(path.dirname(GROUP_LINKS_PATH), { recursive: true });
  const tmpPath = `${GROUP_LINKS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(map, null, 2));
  fs.renameSync(tmpPath, GROUP_LINKS_PATH);
}

// Разовая инициализация: если файла соответствий на volume ещё нет (новый
// volume или первый запуск) — засеять начальными данными.
function ensureGroupLinksSeeded() {
  if (fs.existsSync(GROUP_LINKS_PATH)) return;
  try {
    writeGroupLinks(SEED_DATA);
    console.log('[group-links] файла соответствий нет — первичный посев начальными данными');
  } catch (err) {
    console.error('[group-links] не удалось засеять файл соответствий (volume недоступен?):', err.message);
  }
}

function setGroupLink(internalId, inviteLink) {
  const map = readGroupLinks();
  map[String(internalId)] = inviteLink;
  writeGroupLinks(map);
  return map;
}

// Извлекает internal id из ссылки вида https://t.me/c/<id>/<номер>,
// или null, если ссылка не такого вида.
function extractInternalGroupId(link) {
  const match = String(link || '').match(/^https:\/\/t\.me\/c\/(\d+)(?:\/\d+)?/i);
  return match ? match[1] : null;
}

// Если groupLink — внутренняя ссылка и для её id есть соответствие в таблице,
// возвращает пригласительную ссылку; иначе null.
function resolveInviteLink(groupLink) {
  const internalId = extractInternalGroupId(groupLink);
  if (!internalId) return null;
  const map = readGroupLinks();
  return map[internalId] || null;
}

module.exports = {
  readGroupLinks,
  setGroupLink,
  ensureGroupLinksSeeded,
  extractInternalGroupId,
  resolveInviteLink,
};
