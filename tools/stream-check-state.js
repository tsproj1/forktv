/*
 * 批量检测脚本使用的状态管理器。
 * 不自动写入永久黑名单；只维护 URL 失效缓存和主机信誉库。
 */
const fs = require('fs');

const paths = {
  config: 'data/stream-check/config.json',
  failureCache: 'data/stream-check/failure-cache.json',
  hostReputation: 'data/stream-check/host-reputation.json',
};

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporaryPath, path);
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/^video:\/\//i, '').split('$', 1)[0];
}

function hostKey(url) {
  try { return new URL(normalizeUrl(url)).host.toLowerCase(); }
  catch { return ''; }
}

function dateFrom(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function createState() {
  const config = readJson(paths.config, {});
  const failureCache = readJson(paths.failureCache, { version: 1, records: {} });
  const hostReputation = readJson(paths.hostReputation, { version: 1, records: {} });
  failureCache.records ||= {};
  hostReputation.records ||= {};
  return { config, failureCache, hostReputation };
}

function isUrlInRetryPeriod(state, url, now = new Date()) {
  const record = state.failureCache.records[normalizeUrl(url)];
  if (!record) return false;
  const checkedAt = dateFrom(record.lastChecked);
  if (!checkedAt) return false;
  const retryHours = state.config.retryHours || {};
  let hours = retryHours[record.reason] ?? retryHours.other ?? 24;
  const longFailure = state.config.longFailure || {};
  const firstFailedAt = dateFrom(record.firstFailedAt);
  if (firstFailedAt && record.failCount >= (longFailure.minFailCount ?? 5)
      && now - firstFailedAt >= (longFailure.minFailureDays ?? 7) * 86400000) {
    hours = Math.max(hours, longFailure.retryHours ?? 720);
  }
  return now - checkedAt < hours * 3600000;
}

function isHostTemporarilySkipped(state, url, now = new Date()) {
  const record = state.hostReputation.records[hostKey(url)];
  const skipUntil = dateFrom(record?.skipUntil);
  return Boolean(skipUntil && now < skipUntil);
}

function updateHostEligibility(state, host, now) {
  const record = state.hostReputation.records[host];
  if (!record) return;
  const settings = state.config.hostReputation || {};
  const entries = Object.values(record.urls || {});
  const strongReasons = new Set(state.config.longFailure?.strongReasons || []);
  const distinctUrls = entries.length;
  const observationDays = new Set(entries.flatMap(entry => entry.failureDays || [])).size;
  const successes = entries.reduce((total, entry) => total + (entry.successCount || 0), 0);
  const strongFailures = entries.reduce((total, entry) => total + (entry.strongFailCount || 0), 0);
  record.summary = { distinctUrls, observationDays, successes, strongFailures };

  const eligible = distinctUrls >= (settings.minDistinctUrls ?? 10)
    && observationDays >= (settings.minObservationDays ?? 2)
    && successes === 0
    && strongFailures >= (settings.minStrongFailures ?? 8);

  if (!eligible) {
    delete record.skipUntil;
    delete record.candidateSince;
    record.permanentCandidate = false;
    return;
  }

  record.candidateSince ||= now.toISOString();
  record.skipUntil = new Date(now.getTime() + (settings.temporarySkipHours ?? 72) * 3600000).toISOString();
  const candidateSince = dateFrom(record.candidateSince);
  record.permanentCandidate = Boolean(candidateSince && now - candidateSince >= (settings.candidateReviewDays ?? 30) * 86400000);
}

function recordFailure(state, url, reason, now = new Date()) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) return;
  const timestamp = now.toISOString();
  const oldFailure = state.failureCache.records[normalizedUrl] || {};
  state.failureCache.records[normalizedUrl] = {
    firstFailedAt: oldFailure.firstFailedAt || timestamp,
    lastChecked: timestamp,
    failCount: (oldFailure.failCount || 0) + 1,
    reason,
  };

  const host = hostKey(normalizedUrl);
  if (!host) return;
  const record = state.hostReputation.records[host] ||= { urls: {} };
  const urlRecord = record.urls[normalizedUrl] ||= {
    firstSeen: timestamp, failCount: 0, successCount: 0, strongFailCount: 0, failureDays: [],
  };
  urlRecord.lastChecked = timestamp;
  urlRecord.lastReason = reason;
  urlRecord.failCount += 1;
  if ((state.config.longFailure?.strongReasons || []).includes(reason)) urlRecord.strongFailCount += 1;
  if (!urlRecord.failureDays.includes(dayKey(now))) urlRecord.failureDays.push(dayKey(now));
  updateHostEligibility(state, host, now);
}

function recordSuccess(state, url, now = new Date()) {
  const normalizedUrl = normalizeUrl(url);
  delete state.failureCache.records[normalizedUrl];
  const host = hostKey(normalizedUrl);
  if (!host) return;
  const record = state.hostReputation.records[host] ||= { urls: {} };
  const urlRecord = record.urls[normalizedUrl] ||= {
    firstSeen: now.toISOString(), failCount: 0, successCount: 0, strongFailCount: 0, failureDays: [],
  };
  urlRecord.lastChecked = now.toISOString();
  urlRecord.successCount += 1;
  updateHostEligibility(state, host, now);
}

function seedHostHistoryFromFailureCache(state) {
  for (const [url, failure] of Object.entries(state.failureCache.records)) {
    const host = hostKey(url);
    const checkedAt = dateFrom(failure.lastChecked);
    if (!host || !checkedAt) continue;
    const record = state.hostReputation.records[host] ||= { urls: {} };
    const urlRecord = record.urls[url] ||= {
      firstSeen: failure.firstFailedAt || failure.lastChecked,
      failCount: failure.failCount || 0,
      successCount: 0,
      strongFailCount: 0,
      failureDays: [],
    };
    urlRecord.lastChecked ||= failure.lastChecked;
    urlRecord.lastReason ||= failure.reason;
    if (!urlRecord.failureDays.includes(dayKey(checkedAt))) urlRecord.failureDays.push(dayKey(checkedAt));
    if ((state.config.longFailure?.strongReasons || []).includes(failure.reason)) {
      urlRecord.strongFailCount = Math.max(urlRecord.strongFailCount || 0, failure.failCount || 1);
    }
  }
}

function prune(state, now = new Date()) {
  const cacheCutoff = now.getTime() - (state.config.staleRecordDays ?? 90) * 86400000;
  for (const [url, record] of Object.entries(state.failureCache.records)) {
    if ((dateFrom(record.lastChecked)?.getTime() ?? 0) < cacheCutoff) delete state.failureCache.records[url];
  }
  const historyCutoff = now.getTime() - (state.config.hostReputation?.historyDays ?? 90) * 86400000;
  for (const record of Object.values(state.hostReputation.records)) {
    for (const [url, entry] of Object.entries(record.urls || {})) {
      if ((dateFrom(entry.lastChecked)?.getTime() ?? 0) < historyCutoff) delete record.urls[url];
    }
  }
}

function saveState(state, now = new Date()) {
  prune(state, now);
  state.failureCache.updatedAt = now.toISOString();
  state.hostReputation.updatedAt = now.toISOString();
  writeJsonAtomic(paths.failureCache, state.failureCache);
  writeJsonAtomic(paths.hostReputation, state.hostReputation);
}

module.exports = { createState, isUrlInRetryPeriod, isHostTemporarilySkipped, recordFailure, recordSuccess, seedHostHistoryFromFailureCache, saveState, normalizeUrl, hostKey };
