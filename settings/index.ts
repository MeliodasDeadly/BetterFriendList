/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { makeRange, OptionType } from "@utils/types";

export const PLAYING_ZOOM_OPTIONS = [
    { label: "Compact", value: "compact" as const },
    { label: "Normal", value: "normal" as const, default: true },
    { label: "Large", value: "large" as const },
];

export type PlayingZoom = (typeof PLAYING_ZOOM_OPTIONS)[number]["value"];

export const FRIENDS_REFRESH_MIN_S = 30;
export const FRIENDS_REFRESH_MAX_S = 60;
export const FRIENDS_REFRESH_DEFAULT_S = 45;

export const settings = definePluginSettings({
    playingZoom: {
        type: OptionType.SELECT,
        description: "Game card size on Playing (saved) / Taille des cartes En jeu (sauvegardée)",
        options: [...PLAYING_ZOOM_OPTIONS],
    },
    friendsRefreshSeconds: {
        type: OptionType.SLIDER,
        description: "Refresh Friends UI every N seconds (only while on Friends) / Rafraîchir l'UI Amis toutes les N secondes (uniquement sur Amis)",
        markers: makeRange(FRIENDS_REFRESH_MIN_S, FRIENDS_REFRESH_MAX_S, 5),
        default: FRIENDS_REFRESH_DEFAULT_S,
        stickToMarkers: false,
    },
});
