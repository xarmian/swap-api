export const MAX_APP_TOTAL_TXN_REFERENCES = 8;
export const MAX_APP_TXN_ACCOUNTS = 4;

export function refKey(value, kind = 'id') {
  return kind === 'id' ? BigInt(value).toString() : String(value);
}

export function includesRef(list, value, kind = 'id') {
  const key = refKey(value, kind);
  return (list || []).some(entry => refKey(entry, kind) === key);
}

export function addRefOnce(list, value, kind = 'id') {
  const refs = list || [];
  if (!includesRef(refs, value, kind)) refs.push(value);
  return refs;
}

export function dedupeRefs(list, kind = 'id') {
  const seen = new Set();
  return (list || []).filter(value => {
    const key = refKey(value, kind);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function dedupeAppCallReferences(appCall) {
  const apps = dedupeRefs(appCall.foreignApps);
  const assets = dedupeRefs(appCall.foreignAssets);
  const accounts = dedupeRefs(appCall.accounts, 'account');
  const calledApp = appCall.appIndex == null ? null : refKey(appCall.appIndex);
  const foreignApps = apps.filter(app => refKey(app) !== calledApp);
  const removed = {
    apps: (appCall.foreignApps || []).length - apps.length,
    assets: (appCall.foreignAssets || []).length - assets.length,
    accounts: (appCall.accounts || []).length - accounts.length,
    selfApp: apps.length - foreignApps.length
  };
  appCall.foreignApps = foreignApps;
  appCall.foreignAssets = assets;
  appCall.accounts = accounts;
  return removed;
}

export function countReferences(appCall) {
  return ['boxes', 'foreignApps', 'foreignAssets', 'accounts']
    .reduce((total, key) => total + (appCall[key] || []).length, 0);
}

export function normalizeGroupReferences(txns) {
  const summary = [];
  txns.forEach((txn, index) => {
    if (txn.type !== 'appl') return;
    const removed = dedupeAppCallReferences(txn.applicationCall || txn);
    if (Object.values(removed).some(count => count > 0)) {
      summary.push({ index, ...removed });
    }
  });
  return summary;
}

export function assertWithinReferenceLimits(txns) {
  txns.forEach((txn, index) => {
    if (txn.type !== 'appl') return;
    const appCall = txn.applicationCall || txn;
    const apps = (appCall.foreignApps || []).length;
    const assets = (appCall.foreignAssets || []).length;
    const accounts = (appCall.accounts || []).length;
    const boxes = (appCall.boxes || []).length;
    const total = countReferences(appCall);
    if (total > MAX_APP_TOTAL_TXN_REFERENCES || accounts > MAX_APP_TXN_ACCOUNTS ||
        apps > MAX_APP_TOTAL_TXN_REFERENCES || assets > MAX_APP_TOTAL_TXN_REFERENCES) {
      throw new Error(`Transaction group exceeds the AVM reference limit: txn ${index} (app ${appCall.appIndex}) has ${total} references (apps ${apps}, assets ${assets}, accounts ${accounts}, boxes ${boxes}); the limit is ${MAX_APP_TOTAL_TXN_REFERENCES} total references and ${MAX_APP_TXN_ACCOUNTS} accounts`);
    }
  });
}

export function addBoxAppsToForeignApps(foreignApps, boxes) {
  const refs = foreignApps || [];
  for (const box of boxes || []) {
    addRefOnce(refs, BigInt(box.appIndex));
  }
  return refs;
}
