/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { VoiceChannelIndicator } from "@plugins/userVoiceShow/components";
import { classNameFactory } from "@utils/css";
import { openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import type { Activity, FluxStore, User } from "@vencord/discord-types";
import { ActivityFlags, ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, ApplicationStore, FluxDispatcher, IconUtils, LocaleStore, PresenceStore, RelationshipStore, scrollerClasses, showToast, useEffect, useRef, UserStore, useState } from "@webpack/common";

import { collatorLocale, t, usePluginLang } from "../i18n";
import { PLAYING_ZOOM_OPTIONS, type PlayingZoom, settings } from "../settings";
import { getNextFriendsRefreshAt, subscribeFriendsRefresh } from "../utils/friendsRefresh";

const cl = classNameFactory("vc-bfl-");

const JOINABLE_FLAGS = ActivityFlags.JOIN | ActivityFlags.JOIN_REQUEST | ActivityFlags.SUPPORTS_GATEWAY_ACTIVITY_ACTION_JOIN;
const COVER_SIZE = 512;
/** Coalesce PresenceStore-driven card rebuilds (presence ticks are very chatty). */
const PRESENCE_THROTTLE_MS = 140;

export const PLAYING_SECTION = "PLAYING";

interface PlayingFriend {
    userId: string;
    name: string;
    avatar: string | null;
    initial: string;
    canJoin: boolean;
    activity: Activity;
}

interface GameCard {
    key: string;
    name: string;
    applicationId: string | null;
    imageKey: string | null;
    friends: PlayingFriend[];
    isSelfPlaying: boolean;
}

function sortByName(a: PlayingFriend, b: PlayingFriend) {
    return a.name.localeCompare(b.name, collatorLocale());
}

function sortCards(a: GameCard, b: GameCard) {
    return Number(b.isSelfPlaying) - Number(a.isSelfPlaying)
        || b.friends.length - a.friends.length
        || a.name.localeCompare(b.name, collatorLocale());
}

/** Resolved cover URLs keyed by `${applicationId}:${imageKey}` (or `app:${applicationId}` for app icon fallback). */
const coverCache = new Map<string, string | null>();
/** In-flight resolvers to avoid stampede when many cards share the same asset. */
const coverInflight = new Map<string, Promise<string | null>>();
/** Per-key listeners so only the Cover that cares re-renders when a URL lands. */
const coverListeners = new Map<string, Set<() => void>>();
let coverNotifyRaf: number | null = null;
const coverNotifyPending = new Set<string>();

function canJoinActivity(activity: Activity) {
    return activity.party?.id != null && ((activity.flags ?? 0) & JOINABLE_FLAGS) !== 0;
}

function cacheKey(applicationId: string | null | undefined, imageKey: string | null | undefined) {
    if (imageKey) return `${applicationId ?? ""}:${imageKey}`;
    return applicationId ? `app:${applicationId}` : null;
}

function peekCover(applicationId: string | null, imageKey: string | null): string | null | undefined {
    const key = cacheKey(applicationId, imageKey);
    if (key == null) return undefined;
    return coverCache.has(key) ? coverCache.get(key)! : undefined;
}

function subscribeCover(key: string, listener: () => void) {
    let set = coverListeners.get(key);
    if (!set) {
        set = new Set();
        coverListeners.set(key, set);
    }
    set.add(listener);
    return () => {
        set!.delete(listener);
        if (set!.size === 0) coverListeners.delete(key);
    };
}

function notifyCoverKey(key: string) {
    coverNotifyPending.add(key);
    if (coverNotifyRaf != null) return;
    coverNotifyRaf = requestAnimationFrame(() => {
        coverNotifyRaf = null;
        const keys = [...coverNotifyPending];
        coverNotifyPending.clear();
        for (const k of keys) {
            const set = coverListeners.get(k);
            if (!set) continue;
            for (const listener of set) listener();
        }
    });
}

/** Sync URL for http(s) / media-proxy / platform prefixes (no network). */
function prefixedAssetUrl(image: string): string | null {
    if (/^https?:/i.test(image)) return image;
    if (image.startsWith("mp:")) return `https://media.discordapp.net/${image.slice(3)}`;
    if (image.startsWith("spotify:")) return `https://i.scdn.co/image/${image.slice(8)}`;
    if (image.startsWith("youtube:")) return `https://i.ytimg.com/vi/${image.slice(8)}/hqdefault_live.jpg`;
    if (image.startsWith("twitch:")) return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${image.slice(7)}.png`;
    return null;
}

/** Rewrite broken CDN URLs that embed `mp:…` in the path (common getAssetImage pitfall). */
function rewriteBrokenMpCdnUrl(url: string): string {
    const match = url.match(/\/app-assets\/\d+\/mp:(.+?)(?:\.(?:png|jpe?g|webp))?(?:\?.*)?$/i);
    return match ? `https://media.discordapp.net/${match[1]}` : url;
}

function syncAssetUrl(applicationId: string | null | undefined, image: string): string | null {
    const prefixed = prefixedAssetUrl(image);
    if (prefixed) return prefixed;

    if (applicationId) {
        try {
            const url = ApplicationAssetUtils.getAssetImage(applicationId, image, COVER_SIZE);
            if (typeof url === "string" && url.length > 0) return rewriteBrokenMpCdnUrl(url);
        } catch { /* size / format edge cases */ }

        // Named or numeric asset id → standard CDN app-assets URL
        return `https://cdn.discordapp.com/app-assets/${applicationId}/${image}.png?size=${COVER_SIZE}`;
    }

    return null;
}

function applicationCoverUrl(applicationId: string | null | undefined): string | null {
    if (!applicationId) return null;
    try {
        const app = ApplicationStore.getApplication(applicationId);
        const hash = app?.coverImage || app?.icon;
        if (!hash) return null;

        try {
            const url = IconUtils.getApplicationIconURL({
                id: applicationId,
                icon: hash,
                size: COVER_SIZE,
            });
            if (typeof url === "string" && url.length > 0) return url;
        } catch { /* fall through to CDN */ }

        return `https://cdn.discordapp.com/app-icons/${applicationId}/${hash}.png?size=${COVER_SIZE}`;
    } catch {
        return null;
    }
}

async function resolveCoverOnce(applicationId: string | null, imageKey: string | null): Promise<string | null> {
    let url: string | null = null;

    if (imageKey) {
        // Already a full URL or media-proxy / platform key — no fetch needed
        const prefixed = prefixedAssetUrl(imageKey);
        if (prefixed) {
            url = prefixed;
        } else if (applicationId) {
            // Named Discord Games / Embedded asset keys need fetchAssetIds; numeric ids use CDN directly
            if (!/^\d+$/.test(imageKey)) {
                try {
                    const [resolved] = await ApplicationAssetUtils.fetchAssetIds(applicationId, [imageKey]);
                    if (typeof resolved === "string" && resolved.length > 0) {
                        url = syncAssetUrl(applicationId, resolved);
                    }
                } catch { /* fall through */ }
            }

            url ??= syncAssetUrl(applicationId, imageKey);
        } else {
            url = syncAssetUrl(null, imageKey);
        }
    }

    // Discord Games shelf cover / app icon when RPC has no usable large_image
    url ??= applicationCoverUrl(applicationId);

    const key = cacheKey(applicationId, imageKey);
    // Cache definitive results; skip caching null app-only lookups (app may hydrate later)
    if (key != null && (url != null || imageKey != null)) {
        coverCache.set(key, url);
        notifyCoverKey(key);
    }
    return url;
}

async function resolveCoverUrl(applicationId: string | null, imageKey: string | null): Promise<string | null> {
    const key = cacheKey(applicationId, imageKey);
    if (key != null && coverCache.has(key)) return coverCache.get(key)!;

    if (key != null) {
        const pending = coverInflight.get(key);
        if (pending) return pending;
    }

    const work = resolveCoverOnce(applicationId, imageKey);
    if (key != null) coverInflight.set(key, work);

    try {
        return await work;
    } finally {
        if (key != null) coverInflight.delete(key);
    }
}

function avatarUrl(user: User) {
    try {
        return user.getAvatarURL(null, 80, false);
    } catch {
        try {
            return IconUtils.getUserAvatarURL(user, false, 80);
        } catch {
            return null;
        }
    }
}

function displayName(user: User) {
    return user.globalName || user.username;
}

function foldGameName(name: string) {
    return name.trim().toLocaleLowerCase(collatorLocale());
}

/** Stable card key: prefer application_id; otherwise folded display name. */
function playingActivityKey(activity: Activity) {
    return activity.application_id
        ? `app:${activity.application_id}`
        : `name:${foldGameName(activity.name)}`;
}

function selfPlayingIndex() {
    const keys = new Set<string>();
    const names = new Set<string>();
    try {
        const me = UserStore.getCurrentUser();
        if (!me) return { keys, names };
        for (const activity of PresenceStore.getActivities(me.id) ?? []) {
            if (activity?.type !== ActivityType.PLAYING || !activity.name) continue;
            keys.add(playingActivityKey(activity));
            names.add(foldGameName(activity.name));
        }
    } catch { /* store unavailable */ }
    return { keys, names };
}

function isSelfPlayingCard(mine: ReturnType<typeof selfPlayingIndex>, card: GameCard) {
    return mine.keys.has(card.key) || mine.names.has(foldGameName(card.name));
}

function enrichCard(card: GameCard, activity: Activity) {
    const appId = activity.application_id ?? null;
    if (appId && !card.applicationId) card.applicationId = appId;
    if (activity.assets?.large_image && !card.imageKey) card.imageKey = activity.assets.large_image;
    // Prefer the name from an activity that carries an application id (canonical RPC title).
    if (appId && activity.name) card.name = activity.name;
}

/**
 * Resolve the map slot for this activity, merging name-only cards into
 * application_id cards (and vice versa) when the folded name matches.
 */
function resolveGameCard(cards: Map<string, GameCard>, activity: Activity): GameCard {
    const appId = activity.application_id ?? null;
    const folded = foldGameName(activity.name);

    if (appId) {
        const appKey = `app:${appId}`;
        let card = cards.get(appKey);
        if (!card) {
            const nameKey = `name:${folded}`;
            const byName = cards.get(nameKey);
            if (byName) {
                cards.delete(nameKey);
                byName.key = appKey;
                byName.applicationId = appId;
                cards.set(appKey, byName);
                card = byName;
            }
        }
        if (!card) {
            card = {
                key: appKey,
                name: activity.name,
                applicationId: appId,
                imageKey: activity.assets?.large_image ?? null,
                friends: [],
                isSelfPlaying: false,
            };
            cards.set(appKey, card);
        }
        enrichCard(card, activity);
        return card;
    }

    for (const existing of cards.values()) {
        if (foldGameName(existing.name) === folded) {
            enrichCard(existing, activity);
            return existing;
        }
    }

    const nameKey = `name:${folded}`;
    let card = cards.get(nameKey);
    if (!card) {
        card = {
            key: nameKey,
            name: activity.name,
            applicationId: null,
            imageKey: activity.assets?.large_image ?? null,
            friends: [],
            isSelfPlaying: false,
        };
        cards.set(nameKey, card);
    }
    enrichCard(card, activity);
    return card;
}

function upsertFriend(card: GameCard, friend: PlayingFriend) {
    const index = card.friends.findIndex(entry => entry.userId === friend.userId);
    if (index === -1) {
        card.friends.push(friend);
        return;
    }
    const previous = card.friends[index];
    // Keep joinable activity when the same friend appears under merged keys.
    if (!previous.canJoin && friend.canJoin) card.friends[index] = friend;
}

export function buildGameCards(): GameCard[] {
    try {
        let ids: string[] = [];
        try {
            ids = RelationshipStore.getFriendIDs();
        } catch {
            return [];
        }

        const mine = selfPlayingIndex();
        const cards = new Map<string, GameCard>();

        for (const userId of ids) {
            let user: User | undefined;
            let activities: Activity[] = [];
            try {
                user = UserStore.getUser(userId);
                activities = PresenceStore.getActivities(userId) ?? [];
            } catch {
                continue;
            }
            if (!user) continue;

            // Track by userId which map slots already received this friend (keys can
            // change when a name-only card is merged into an app: card mid-loop).
            const seenCards = new Set<GameCard>();
            for (const activity of activities) {
                if (activity?.type !== ActivityType.PLAYING || typeof activity.name !== "string" || !activity.name) continue;

                const card = resolveGameCard(cards, activity);
                if (seenCards.has(card)) continue;
                seenCards.add(card);

                const name = displayName(user);
                upsertFriend(card, {
                    userId,
                    name,
                    avatar: avatarUrl(user),
                    initial: name.slice(0, 1).toUpperCase(),
                    canJoin: canJoinActivity(activity),
                    activity,
                });
            }
        }

        return [...cards.values()]
            .map(card => ({
                ...card,
                isSelfPlaying: isSelfPlayingCard(mine, card),
                friends: [...card.friends].sort(sortByName),
            }))
            .sort(sortCards);
    } catch {
        return [];
    }
}

function cardsEqual(previous: GameCard[], next: GameCard[]) {
    if (previous === next) return true;
    if (previous.length !== next.length) return false;
    return previous.every((card, index) => {
        const other = next[index];
        return card.key === other.key
            && card.name === other.name
            && card.applicationId === other.applicationId
            && card.imageKey === other.imageKey
            && card.isSelfPlaying === other.isSelfPlaying
            && card.friends.length === other.friends.length
            && card.friends.every((friend, friendIndex) => {
                const nextFriend = other.friends[friendIndex];
                return friend.userId === nextFriend.userId
                    && friend.name === nextFriend.name
                    && friend.avatar === nextFriend.avatar
                    && friend.canJoin === nextFriend.canJoin;
            });
    });
}

/**
 * Throttle Flux-driven rebuilds: PresenceStore emits constantly; building N cards
 * every tick tanks FPS even when cardsEqual would skip the React commit.
 * `stores` must be a stable module-level (or memoized) array — not an inline literal.
 */
function useThrottledStoreValue<T>(
    stores: readonly FluxStore[],
    factory: () => T,
    isEqual: (a: T, b: T) => boolean,
    delayMs = PRESENCE_THROTTLE_MS,
): T {
    const [value, setValue] = useState(factory);
    const latestRef = useRef(value);
    const factoryRef = useRef(factory);
    const equalRef = useRef(isEqual);
    factoryRef.current = factory;
    equalRef.current = isEqual;

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let raf: number | null = null;
        let alive = true;

        const flush = () => {
            timer = null;
            raf = null;
            if (!alive || document.hidden) return;
            const next = factoryRef.current();
            if (equalRef.current(latestRef.current, next)) return;
            latestRef.current = next;
            setValue(next);
        };

        const schedule = () => {
            if (timer != null || document.hidden) return;
            timer = setTimeout(() => {
                raf = requestAnimationFrame(flush);
            }, delayMs);
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
        // Stores are stable Flux singletons captured from the first render.
    }, [delayMs]);

    return value;
}

let playingCardStores: FluxStore[] | null = null;
function getPlayingCardStores() {
    playingCardStores ??= [PresenceStore, RelationshipStore, UserStore, LocaleStore];
    return playingCardStores;
}

function joinFriend(friend: PlayingFriend) {
    if (!friend.canJoin) return;
    const { activity } = friend;
    try {
        FluxDispatcher.dispatch({
            type: "ACTIVITY_JOIN",
            userId: friend.userId,
            applicationId: activity.application_id,
            partyId: activity.party?.id,
            sessionId: activity.session_id,
        });
    } catch {
        // Discord rejects the join when the party is private or the activity has no join secret.
    }
}

function friendCountLabel(count: number) {
    return count === 1 ? t("playing.friendOne") : t("playing.friendMany", { count });
}

const ZOOM_LABEL_KEYS = {
    compact: "playing.zoomCompact",
    normal: "playing.zoomNormal",
    large: "playing.zoomLarge",
} as const;

const Cover = ErrorBoundary.wrap(function Cover({ name, applicationId, imageKey }: {
    name: string;
    applicationId: string | null;
    imageKey: string | null;
}) {
    const key = cacheKey(applicationId, imageKey);
    const forceUpdate = useForceUpdater();
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (key == null) return;
        return subscribeCover(key, forceUpdate);
    }, [key, forceUpdate]);

    useEffect(() => {
        setFailed(false);
        if (peekCover(applicationId, imageKey) !== undefined) return;
        void resolveCoverUrl(applicationId, imageKey);
    }, [applicationId, imageKey]);

    const image = peekCover(applicationId, imageKey);

    if (failed || image === null) {
        return (
            <div className={cl("cover")}>
                <span className={cl("cover-fallback")}>{name.slice(0, 1).toUpperCase()}</span>
            </div>
        );
    }

    if (image === undefined) {
        return <div className={cl("cover", "cover-skeleton")} aria-hidden="true" />;
    }

    return (
        <div className={cl("cover")}>
            <img
                className={cl("cover-img")}
                src={image}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => setFailed(true)}
            />
        </div>
    );
}, { noop: true });

const Player = ErrorBoundary.wrap(function Player({ friend }: { friend: PlayingFriend; }) {
    const profileLabel = t("playing.viewProfile", { name: friend.name });

    return (
        <div className={cl("player")}>
            <button
                type="button"
                className={cl("player-profile")}
                title={profileLabel}
                aria-label={profileLabel}
                onClick={() => {
                    void openUserProfile(friend.userId).catch(() => {
                        showToast({ text: profileLabel, variant: "critical" });
                    });
                }}
            >
                {friend.avatar != null ? (
                    <img
                        className={cl("avatar")}
                        src={friend.avatar}
                        alt=""
                        loading="lazy"
                        decoding="async"
                    />
                ) : (
                    <span className={cl("avatar", "avatar-fallback")}>{friend.initial}</span>
                )}
                <span className={cl("player-name")}>{friend.name}</span>
            </button>
            <div className={cl("voice-icon")} onClick={event => event.stopPropagation()}>
                <VoiceChannelIndicator userId={friend.userId} isActionButton />
            </div>
            <button
                type="button"
                className={cl("join")}
                disabled={!friend.canJoin}
                title={friend.canJoin ? t("playing.joinNamed", { name: friend.name }) : t("playing.joinUnavailable")}
                onClick={() => joinFriend(friend)}
            >
                {t("playing.join")}
            </button>
        </div>
    );
}, { noop: true });

function ZoomControl({ value, onChange }: {
    value: PlayingZoom;
    onChange: (zoom: PlayingZoom) => void;
}) {
    return (
        <div className={cl("zoom")}>
            <span className={cl("zoom-caption")}>{t("playing.zoomCaption")}</span>
            <div className={cl("zoom-options")} role="group" aria-label={t("playing.zoomAria")}>
                {PLAYING_ZOOM_OPTIONS.map(option => {
                    const selected = value === option.value;
                    return (
                        <button
                            key={option.value}
                            type="button"
                            className={cl("zoom-btn", { selected })}
                            aria-pressed={selected}
                            onClick={() => onChange(option.value)}
                        >
                            {t(ZOOM_LABEL_KEYS[option.value])}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function secondsUntilRefresh(at: number) {
    if (at <= 0) return 0;
    return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** Top-left countdown for the Friends periodic refresh; games still update live via Presence. */
function RefreshCountdown() {
    usePluginLang();
    const forceUpdate = useForceUpdater();
    const [seconds, setSeconds] = useState(() => secondsUntilRefresh(getNextFriendsRefreshAt()));

    useEffect(() => subscribeFriendsRefresh(forceUpdate), [forceUpdate]);

    useEffect(() => {
        const tick = () => setSeconds(secondsUntilRefresh(getNextFriendsRefreshAt()));
        tick();
        const id = setInterval(tick, 250);
        return () => clearInterval(id);
    }, []);

    const label = seconds <= 0
        ? t("playing.refreshNow")
        : t("playing.refreshIn", { seconds });

    return (
        <div className={cl("refresh")} title={t("playing.refreshLive")} role="status" aria-live="polite">
            <span className={cl("refresh-live")}>{t("playing.refreshLive")}</span>
            <span className={cl("refresh-sep")} aria-hidden="true">·</span>
            <span className={cl("refresh-countdown")}>{label}</span>
        </div>
    );
}

export const PlayingPage = ErrorBoundary.wrap(function PlayingPage() {
    usePluginLang();
    const cards = useThrottledStoreValue(
        getPlayingCardStores(),
        buildGameCards,
        cardsEqual,
    );
    const { playingZoom } = settings.use(["playingZoom"]);
    const zoom: PlayingZoom = PLAYING_ZOOM_OPTIONS.some(option => option.value === playingZoom)
        ? playingZoom
        : "normal";

    // Warm covers once per card set — resolves land via coverListeners, no setState storm.
    useEffect(() => {
        for (const card of cards) {
            if (peekCover(card.applicationId, card.imageKey) !== undefined) continue;
            void resolveCoverUrl(card.applicationId, card.imageKey);
        }
    }, [cards]);

    return (
        <div className={classes(cl("playing-page"), scrollerClasses.thin, scrollerClasses.customTheme)}>
            <div className={cl("playing-toolbar")}>
                <RefreshCountdown />
                <ZoomControl
                    value={zoom}
                    onChange={next => { settings.store.playingZoom = next; }}
                />
            </div>
            {cards.length === 0 ? (
                <div className={cl("empty-block")}>
                    <p className={cl("empty", "empty-title")}>{t("playing.emptyTitle")}</p>
                    <p className={cl("empty", "empty-hint")}>{t("playing.emptyHint")}</p>
                </div>
            ) : (
                <div className={cl("games")} data-zoom={zoom}>
                    {cards.map(card => (
                        <article
                            key={card.key}
                            className={cl("card", { "self-playing": card.isSelfPlaying })}
                        >
                            <Cover
                                name={card.name}
                                applicationId={card.applicationId}
                                imageKey={card.imageKey}
                            />
                            <div className={cl("card-body")}>
                                <h3 className={cl("game-name")}>{card.name}</h3>
                                <p className={cl("game-count")}>{friendCountLabel(card.friends.length)}</p>
                            </div>
                            <div className={cl("players")}>
                                {card.friends.map(friend => (
                                    <Player key={friend.userId} friend={friend} />
                                ))}
                            </div>
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}, { noop: true });
