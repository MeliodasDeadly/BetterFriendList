/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FriendsStore, PresenceStore } from "@webpack/common";

import { FRIENDS_REFRESH_DEFAULT_S, FRIENDS_REFRESH_MAX_S, FRIENDS_REFRESH_MIN_S, settings } from "../settings";

let friendsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let nextFriendsRefreshAt = 0;
const friendsRefreshListeners = new Set<() => void>();
let isOnFriendsPage: () => boolean = () => false;

function friendsRefreshDelayMs() {
    const raw = Number(settings.store.friendsRefreshSeconds);
    const seconds = Number.isFinite(raw)
        ? Math.min(FRIENDS_REFRESH_MAX_S, Math.max(FRIENDS_REFRESH_MIN_S, Math.round(raw)))
        : FRIENDS_REFRESH_DEFAULT_S;
    return seconds * 1000;
}

function notifyFriendsRefreshListeners() {
    for (const listener of friendsRefreshListeners) listener();
}

/** Epoch ms of the next Friends-only periodic refresh (0 if inactive). */
export function getNextFriendsRefreshAt() {
    return nextFriendsRefreshAt;
}

export function subscribeFriendsRefresh(listener: () => void) {
    friendsRefreshListeners.add(listener);
    return () => {
        friendsRefreshListeners.delete(listener);
    };
}

/** Re-read cached presence / list only while the Friends page is open. Games still update live via PresenceStore. */
function refreshFriendsUi() {
    if (document.hidden) return;
    if (!isOnFriendsPage()) return;

    try {
        FriendsStore.emitChange();
    } catch { /* store not ready */ }
    try {
        PresenceStore.emitChange();
    } catch { /* store not ready */ }
}

function clearFriendsRefresh() {
    if (friendsRefreshTimer == null) return;
    clearTimeout(friendsRefreshTimer);
    friendsRefreshTimer = null;
}

function scheduleFriendsRefresh() {
    clearFriendsRefresh();
    const delay = friendsRefreshDelayMs();
    nextFriendsRefreshAt = Date.now() + delay;
    notifyFriendsRefreshListeners();
    friendsRefreshTimer = setTimeout(() => {
        friendsRefreshTimer = null;
        refreshFriendsUi();
        scheduleFriendsRefresh();
    }, delay);
}

/** Start the Friends-only refresh loop. `onFriendsPage` must detect the people list. */
export function startFriendsRefresh(onFriendsPage: () => boolean) {
    isOnFriendsPage = onFriendsPage;
    scheduleFriendsRefresh();
}

export function stopFriendsRefresh() {
    clearFriendsRefresh();
    nextFriendsRefreshAt = 0;
    notifyFriendsRefreshListeners();
    isOnFriendsPage = () => false;
}
