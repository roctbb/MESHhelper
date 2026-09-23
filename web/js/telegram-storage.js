export const TELEGRAM_TOKEN_KEY = 'telegram_access_v1';
export const groupsKey = (accountId) => `telegram_groups_v1_${accountId}`;

export function loadTelegramGroups(storage, accountId) {
  try {
    const value = JSON.parse(storage.getItem(groupsKey(accountId)) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((group) => group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.members))
      .slice(0, 100).map((group) => ({ id: group.id, name: group.name.slice(0, 80),
        members: group.members.filter((member) => member && typeof member.id === 'string' && /^\d+$/.test(member.id) && typeof member.name === 'string')
          .filter((member, index, members) => members.findIndex((item) => item.id === member.id) === index).slice(0, 100) }));
  } catch (_) { return []; }
}

export function saveTelegramGroups(storage, accountId, groups) {
  storage.setItem(groupsKey(accountId), JSON.stringify(groups));
}
