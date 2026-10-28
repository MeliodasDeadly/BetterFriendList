/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { useForceUpdater } from "@utils/react";
import type { Activity, FluxStore } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { createRoot, FluxDispatcher, FriendsStore, LocaleStore, PresenceStore, RelationshipStore, useEffect, useRef, useState, useStateFromStores } from "@webpack/common";

import { collatorLocale, type MessageKey, t, usePluginLang } from "../i18n";
import { startFriendsRefresh, stopFriendsRefresh } from "../utils/friendsRefresh";
import { PLAYING_SECTION, PlayingPage } from "./playing";

const cl = classNameFactory("vc-bfl-");
const HOST_ID = "vc-bfl-host";
/** Debounce FriendsStore.emitChange while typing — emit storms re-render the whole people list. */
const EMIT_DEBOUNCE_MS = 160;
/** Coalesce PresenceStore rebuilds of the activity chip breakdown. */
const PRESENCE_THROTTLE_MS = 140;

export const ACTIVITY_CATEGORIES = [
    { type: ActivityType.PLAYING, labelKey: "category.playing" satisfies MessageKey },
    { type: ActivityType.STREAMING, labelKey: "category.streaming" satisfies MessageKey },
    { type: ActivityType.LISTENING, labelKey: "category.listening" satisfies MessageKey },
    { type: ActivityType.WATCHING, labelKey: "category.watching" satisfies MessageKey },
    { type: ActivityType.COMPETING, labelKey: "category.competing" satisfies MessageKey },
    { type: ActivityType.HANG_STATUS, labelKey: "category.other" satisfies MessageKey },
] as const;

function categoryLabel(labelKey: MessageKey) {
    return t(labelKey);
}

function labelForType(type: ActivityType) {
    const category = ACTIVITY_CATEGORIES.find(item => item.type === type);
    return category ? categoryLabel(category.labelKey) : "";
}

interface SearchState {
    query: string;
    type: ActivityType | null;
    name: string | null;
}

export interface ActivityGame {
    name: string;
    count: number;
}

export interface ActivityGroup {
    type: ActivityType;
    label: string;
    friendCount: number;
    games: ActivityGame[];
}

interface FriendRow {
    userId?: string;
    usernameLower?: string | null;
    nickname?: string | null;
    activities?: Activity[];
    user?: {
        username?: string;
        globalName?: string | null;
    } | null;
}

const emptyState = (): SearchState => ({ query: "", type: null, name: null });

let state = emptyState();
const listeners = new Set<() => void>();
let root: ReturnType<typeof createRoot> | null = null;
let observer: MutationObserver | null = null;
let pendingSync = false;
let emitTimer: ReturnType<typeof setTimeout> | null = null;

function fold(value: string) {
    return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

let noResults = false;
let passMatches = 0;

function hasActiveFilter() {
    return state.query.trim() !== "" || state.type != null;
}

function setNoResults(value: boolean) {
    if (noResults === value) return;
    noResults = value;
    document.body.classList.toggle("vc-bfl-no-results", value);
    queueMicrotask(() => {
        for (const listener of listeners) listener();
    });
}

export function isNoResults() {
    return noResults;
}

function emitFriendsChange() {
    try {
        FriendsStore.emitChange();
    } catch {
        // The friends list reads FriendsStore while rendering. If it is not ready yet, the next presence update refreshes it.
    }
}

function scheduleEmitFriends() {
    if (emitTimer != null) return;
    emitTimer = setTimeout(() => {
        emitTimer = null;
        emitFriendsChange();
    }, EMIT_DEBOUNCE_MS);
}

function flushEmitFriends() {
    if (emitTimer != null) {
        clearTimeout(emitTimer);
        emitTimer = null;
    }
    emitFriendsChange();
}

/** Notify UI listeners immediately; debounce FriendsStore.emitChange unless `immediate`. */
function notify(immediate = false) {
    for (const listener of listeners) listener();
    if (immediate) flushEmitFriends();
    else scheduleEmitFriends();
}

export function getSearchState() {
    return state;
}

export function subscribeSearch(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Discord's own query must not remove rows before {@link matchesRow}. */
export function ownsSearch() {
    return true;
}

export function setTextQuery(query: string) {
    if (state.query === query) return;
    state = { ...state, query };
    notify(false);
}

export function applyActivity(type: ActivityType, name: string | null) {
    const same = state.type === type && state.name === name;
    state = same
        ? { ...state, type: null, name: null }
        : { ...state, type, name };
    notify(true);
}

export function selectAllActivities() {
    if (state.type == null && state.name == null) return;
    state = { ...state, type: null, name: null };
    notify(true);
}

export function clearSearch() {
    if (state.query === "" && state.type == null && state.name == null) return;
    state = emptyState();
    notify(true);
}

export function resetSearch() {
    state = emptyState();
    for (const listener of listeners) listener();
}

function activitiesOf(row: FriendRow): Activity[] {
    let activities = row.activities ?? [];
    if (row.userId) {
        try {
            const live = PresenceStore.getActivities(row.userId);
            if (live?.length) activities = live;
        } catch {
            // Fall back to the activities already stored on the row.
        }
    }

    return activities.filter(activity => activity?.name && activity.type !== ActivityType.CUSTOM_STATUS);
}

export function activityHaystack(row: FriendRow) {
    return activitiesOf(row)
        .map(activity => [labelForType(activity.type), activity.name, activity.details, activity.state].filter(Boolean).join(" "))
        .join(" ");
}

function textMatches(row: FriendRow, query: string) {
    const folded = fold(query);
    const fields = [
        row.usernameLower,
        row.nickname,
        row.user?.username,
        row.user?.globalName,
        activityHaystack(row),
    ];

    return fields.some(field => field != null && fold(field).includes(folded));
}

/** Used by the friends-list patch. An empty result keeps one row so Discord does not open Add Friend. */
export function matchesRow(row: FriendRow, index = 0, all?: FriendRow[]) {
    if (index === 0) passMatches = 0;

    let ok = true;
    try {
        if ((row?.userId == null && row?.user == null) || !hasActiveFilter()) ok = true;
        else {
            const query = state.query.trim();
            ok = (query === "" || textMatches(row, query)) && activityMatches(row);
        }
    } catch {
        ok = true;
    }

    if (ok) passMatches++;

    const isLast = all == null || index === all.length - 1;
    if (!isLast) return ok;

    if (hasActiveFilter() && passMatches === 0) {
        setNoResults(true);
        return true;
    }

    setNoResults(false);
    return ok;
}

function activityMatches(row: FriendRow) {
    const { type, name } = state;
    if (type == null) return true;

    const inCategory = activitiesOf(row).filter(activity => activity.type === type);
    if (inCategory.length === 0) return false;
    if (name != null && !inCategory.some(activity => activity.name === name)) return false;
    return true;
}

export function buildActivityGroups(): ActivityGroup[] {
    let ids: string[] = [];
    try {
        ids = RelationshipStore.getFriendIDs();
    } catch {
        return [];
    }

    const gamesByType = new Map<ActivityType, Map<string, number>>();
    const friendsByType = new Map<ActivityType, Set<string>>();

    for (const id of ids) {
        let activities: Activity[] = [];
        try {
            activities = PresenceStore.getActivities(id) ?? [];
        } catch {
            continue;
        }

        const seen = new Set<string>();
        for (const activity of activities) {
            if (!activity?.name || activity.type === ActivityType.CUSTOM_STATUS) continue;
            const key = `${activity.type}:${activity.name}`;
            if (seen.has(key)) continue;
            seen.add(key);

            let games = gamesByType.get(activity.type);
            if (!games) {
                games = new Map();
                gamesByType.set(activity.type, games);
            }
            games.set(activity.name, (games.get(activity.name) ?? 0) + 1);

            let friends = friendsByType.get(activity.type);
            if (!friends) {
                friends = new Set();
                friendsByType.set(activity.type, friends);
            }
            friends.add(id);
        }
    }

    return ACTIVITY_CATEGORIES.flatMap(category => {
        const games = gamesByType.get(category.type);
        if (!games?.size) return [];

        return [{
            type: category.type,
            label: categoryLabel(category.labelKey),
            friendCount: friendsByType.get(category.type)?.size ?? 0,
            games: [...games.entries()]
                .map(([name, count]) => ({ name, count }))
                .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name, collatorLocale())),
        }];
    });
}

function useSearchState() {
    const forceUpdate = useForceUpdater();
    useEffect(() => subscribeSearch(forceUpdate), [forceUpdate]);
    return getSearchState();
}

function groupsEqual(previous: ActivityGroup[], next: ActivityGroup[]) {
    if (previous === next) return true;
    if (previous.length !== next.length) return false;
    return previous.every((group, index) => {
        const other = next[index];
        return group.type === other.type
            && group.label === other.label
            && group.friendCount === other.friendCount
            && group.games.length === other.games.length
            && group.games.every((game, gameIndex) => {
                const nextGame = other.games[gameIndex];
                return game.name === nextGame.name && game.count === nextGame.count;
            });
    });
}

/**
 * Throttle Presence-driven activity group rebuilds (same idea as Playing cards).
 * `stores` must be a stable module-level array.
 */
function useThrottledGroups(stores: readonly FluxStore[]) {
    const [groups, setGroups] = useState(buildActivityGroups);
    const latestRef = useRef(groups);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let raf: number | null = null;
        let alive = true;

        const flush = () => {
            timer = null;
            raf = null;
            if (!alive || document.hidden) return;
            const next = buildActivityGroups();
            if (groupsEqual(latestRef.current, next)) return;
            latestRef.current = next;
            setGroups(next);
        };

        const schedule = () => {
            if (timer != null || document.hidden) return;
            timer = setTimeout(() => {
                raf = requestAnimationFrame(flush);
            }, PRESENCE_THROTTLE_MS);
        };

        const onVisibility = () => {
            if (!document.hidden) schedule();
        };

        for (const store of stores) store.addChangeListener(schedule);
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            alive = false;
            for (const store of stores) store.removeChangeListener(schedule);
            document.removeEventListener("visibilitychange", onVisibility);
            if (timer != null) clearTimeout(timer);
            if (raf != null) cancelAnimationFrame(raf);
        };
    }, []);

    return groups;
}

let activityGroupStores: FluxStore[] | null = null;
function getActivityGroupStores() {
    activityGroupStores ??= [PresenceStore, RelationshipStore, LocaleStore];
    return activityGroupStores;
}

function tokenLabel(search: SearchState) {
    const category = ACTIVITY_CATEGORIES.find(item => item.type === search.type);
    if (category == null) return null;
    const label = categoryLabel(category.labelKey);
    return search.name == null ? label : `${label} · ${search.name}`;
}

const ActivitySearchView = ErrorBoundary.wrap(function ActivitySearchView() {
    usePluginLang();
    const groups = useThrottledGroups(getActivityGroupStores());
    const search = useSearchState();
    const [draft, setDraft] = useState("");
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    const token = tokenLabel(search);
    const filtering = search.query !== "" || search.type != null;
    const section = useStateFromStores([FriendsStore], () => {
        try {
            return FriendsStore.getState().section;
        } catch {
            return "";
        }
    });
    const onFriendList = section === "ONLINE" || section === "ALL";
    const showBreakdown = open && onFriendList;
    const namedTypes = new Set<ActivityType>([ActivityType.PLAYING, ActivityType.STREAMING, ActivityType.COMPETING]);
    const gameGroups = groups.filter(group => namedTypes.has(group.type));
    const categoryGroups = groups.filter(group => !namedTypes.has(group.type));

    const closeFilters = () => {
        setOpen(false);
        selectAllActivities();
    };

    useEffect(() => {
        if (!open) return;

        const onPointer = (event: PointerEvent) => {
            if (wrapRef.current?.contains(event.target as Node)) return;
            setOpen(false);
            selectAllActivities();
        };
        window.addEventListener("pointerdown", onPointer);
        return () => window.removeEventListener("pointerdown", onPointer);
    }, [open]);

    const choose = (type: ActivityType, name: string | null) => {
        applyActivity(type, name);
    };

    return (
        <div className={cl("bar")} ref={wrapRef}>
            <div className={cl("row")}>
                <div className={cl("field")}>
                    {token != null ? (
                        <button type="button" className={cl("token")} title={token} onClick={() => clearSearch()}>
                            <span className={cl("token-text")}>{token}</span>
                        </button>
                    ) : null}
                    <input
                        className={cl("search")}
                        type="text"
                        value={draft}
                        placeholder={token != null ? t("search.placeholderRefine") : t("search.placeholder")}
                        aria-label={t("search.aria")}
                        onChange={event => {
                            const { value } = event.currentTarget;
                            setDraft(value);
                            setTextQuery(value);
                        }}
                        onKeyDown={event => {
                            if (event.key === "Escape") {
                                if (open) {
                                    closeFilters();
                                    return;
                                }
                                setDraft("");
                                clearSearch();
                                return;
                            }

                            if (event.key === "Backspace" && draft === "" && search.type != null) clearSearch();
                        }}
                    />
                    {filtering ? (
                        <button
                            type="button"
                            className={cl("clear")}
                            onClick={() => {
                                setDraft("");
                                setOpen(false);
                                clearSearch();
                            }}
                        >
                            {t("search.clear")}
                        </button>
                    ) : null}
                </div>
                <button
                    type="button"
                    className={cl("filters", { active: open })}
                    aria-expanded={open}
                    aria-controls="vc-bfl-categories"
                    onClick={() => {
                        if (open) closeFilters();
                        else setOpen(true);
                    }}
                >
                    {t("search.filters")}
                </button>
            </div>

            {isNoResults() ? (
                <p className={cl("empty", "empty-inline")}>{t("search.emptyNoMatch")}</p>
            ) : null}

            {showBreakdown ? (
                <div id="vc-bfl-categories" className={cl("categories")}>
                    <div className={cl("media")} role="group" aria-label={t("search.categoriesAria")}>
                        <button
                            type="button"
                            className={cl("label", { selected: search.type == null })}
                            aria-pressed={search.type == null}
                            onClick={selectAllActivities}
                        >
                            {t("search.all")}
                        </button>
                        {categoryGroups.map(group => {
                            const selected = search.type === group.type && search.name == null;
                            return (
                                <button
                                    key={group.type}
                                    type="button"
                                    className={cl("label", { selected })}
                                    aria-pressed={selected}
                                    title={group.label}
                                    onClick={() => choose(group.type, null)}
                                >
                                    <span className={cl("chip-text")}>{group.label}</span>
                                    <span className={cl("count")}>{group.friendCount}</span>
                                </button>
                            );
                        })}
                    </div>
                    {groups.length === 0 ? (
                        <p className={cl("empty", "empty-inline")}>{t("search.emptyNoActivity")}</p>
                    ) : null}
                    {gameGroups.map(group => (
                        <section key={group.type} className={cl("category")} aria-label={group.label}>
                            <div className={cl("chips")} role="group" aria-label={group.label}>
                                {group.games.map(game => {
                                    const selected = search.type === group.type && search.name === game.name;
                                    return (
                                        <button
                                            key={game.name}
                                            type="button"
                                            className={cl("chip", { selected })}
                                            aria-pressed={selected}
                                            title={game.name}
                                            onClick={() => choose(group.type, game.name)}
                                        >
                                            <span className={cl("chip-text")}>{game.name}</span>
                                            <span className={cl("count")}>{game.count}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                </div>
            ) : null}
        </div>
    );
}, { noop: true });

const FriendsPanel = ErrorBoundary.wrap(function FriendsPanel() {
    const section = useStateFromStores([FriendsStore], () => {
        try {
            return FriendsStore.getState().section as string;
        } catch {
            return "";
        }
    });
    const playing = section === PLAYING_SECTION;

    useEffect(() => {
        if (playing) document.body.classList.add("vc-bfl-playing");
        else document.body.classList.remove("vc-bfl-playing");
        return () => document.body.classList.remove("vc-bfl-playing");
    }, [playing]);

    return playing ? <PlayingPage /> : <ActivitySearchView />;
}, { noop: true });

function findPeopleList() {
    return document.querySelector('[class*="peopleList"]:not([class*="peopleListItem"])')
        ?? document.querySelector("[data-list-id='people-list']");
}

function isSearchBar(element: Element) {
    return [...element.classList].some(name => name.includes("searchBar"));
}

function findNativeSearch(peopleList: Element) {
    let node = peopleList.parentElement;
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
        for (const child of node.children) {
            if (child === peopleList || child.contains(peopleList)) continue;
            if (isSearchBar(child)) return child;
            const nested = child.querySelector('[class*="searchBar"]');
            if (nested) return nested;
        }
    }
    return null;
}

function clearNativeInput(searchBar: Element) {
    const input = searchBar.querySelector("input");
    if (!input?.value) return;

    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

function unmountHost() {
    root?.unmount();
    root = null;
    document.getElementById(HOST_ID)?.remove();
}

function hostIsHealthy(peopleList: Element, host: Element) {
    return host.isConnected && peopleList.previousElementSibling === host;
}

function syncMount() {
    const peopleList = findPeopleList();
    const host = document.getElementById(HOST_ID);

    if (!peopleList) {
        if (host || root) unmountHost();
        return;
    }

    if (host && hostIsHealthy(peopleList, host)) return;

    unmountHost();

    const nativeSearch = findNativeSearch(peopleList);
    if (nativeSearch) {
        clearNativeInput(nativeSearch);
        nativeSearch.classList.add(cl("native-search"));
    }

    const element = document.createElement("div");
    element.id = HOST_ID;
    element.className = cl("host");
    peopleList.before(element);

    root = createRoot(element);
    root.render(<FriendsPanel />);
}

function scheduleSync() {
    if (pendingSync || document.hidden) return;
    pendingSync = true;
    requestAnimationFrame(() => {
        pendingSync = false;
        if (document.hidden) return;
        syncMount();
    });
}

function isPeopleListShell(node: Element) {
    return Boolean(
        node.matches?.('[class*="peopleList"]:not([class*="peopleListItem"]), [data-list-id="people-list"]')
        || node.querySelector?.('[class*="peopleList"]:not([class*="peopleListItem"]), [data-list-id="people-list"]')
    );
}

function mutationTouchesFriendsMount(mutations: MutationRecord[]) {
    const host = document.getElementById(HOST_ID);

    for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
            if (!(node instanceof Element)) continue;
            if (host && (node === host || node.contains(host))) return true;
            if (isPeopleListShell(node)) return true;
        }

        for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            // Ignore pure peopleListItem churn — that is presence/status noise, not shell remounts.
            if (node.matches?.('[class*="peopleListItem"]') && !isPeopleListShell(node)) continue;
            if (isPeopleListShell(node) || (host == null && node.querySelector?.('[class*="peopleList"], [data-list-id="people-list"]'))) {
                return true;
            }
        }
    }

    return false;
}

function onMutations(mutations: MutationRecord[]) {
    if (document.hidden) return;

    const peopleList = findPeopleList();
    const host = document.getElementById(HOST_ID);

    // Healthy mount: ignore presence/list item churn unless our host or peopleList shell moved.
    if (peopleList && host && hostIsHealthy(peopleList, host)) {
        if (!mutationTouchesFriendsMount(mutations)) return;
    } else if (!peopleList && !host) {
        // Not on Friends — skip work until navigation brings the list back.
        return;
    }

    scheduleSync();
}

const onNavigate = () => scheduleSync();

const onVisibility = () => {
    if (!document.hidden) scheduleSync();
};

export function startSearchMount() {
    scheduleSync();
    startFriendsRefresh(() => findPeopleList() != null);
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    FluxDispatcher.subscribe("CHANNEL_SELECT", onNavigate);
    FluxDispatcher.subscribe("FRIENDS_SET_SECTION", onNavigate);
    document.addEventListener("visibilitychange", onVisibility);
}

export function stopSearchMount() {
    observer?.disconnect();
    observer = null;
    stopFriendsRefresh();
    if (emitTimer != null) {
        clearTimeout(emitTimer);
        emitTimer = null;
    }
    FluxDispatcher.unsubscribe("CHANNEL_SELECT", onNavigate);
    FluxDispatcher.unsubscribe("FRIENDS_SET_SECTION", onNavigate);
    document.removeEventListener("visibilitychange", onVisibility);
    document.body.classList.remove("vc-bfl-no-results", "vc-bfl-playing");
    noResults = false;
    document.querySelectorAll(`.${cl("native-search")}`).forEach(element => element.classList.remove(cl("native-search")));
    unmountHost();
    resetSearch();
    emitFriendsChange();
}
