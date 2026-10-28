/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LocaleStore, useStateFromStores } from "@webpack/common";

export type PluginLang = "en" | "fr";

const en = {
    "search.placeholder": "Search for a friend or game",
    "search.placeholderRefine": "Refine by name",
    "search.aria": "Search the friends list",
    "search.clear": "Clear",
    "search.filters": "Filters",
    "search.emptyNoMatch": "No friends match this search.",
    "search.emptyNoActivity": "No friends have an activity right now.",
    "search.all": "All",
    "search.categoriesAria": "Activity categories",

    "category.playing": "Games",
    "category.streaming": "Stream",
    "category.listening": "Listening",
    "category.watching": "Watching",
    "category.competing": "Competing",
    "category.other": "Other",

    "playing.section": "Playing",
    "playing.join": "Join",
    "playing.joinNamed": "Join {name}",
    "playing.joinUnavailable": "Join unavailable for this game",
    "playing.viewProfile": "View {name}'s profile",
    "playing.emptyTitle": "No friends are playing right now.",
    "playing.emptyHint": "Games in progress will show up here when a friend starts an activity.",
    "playing.friendOne": "1 friend",
    "playing.friendMany": "{count} friends",
    "playing.zoomCaption": "Size",
    "playing.zoomAria": "Game card size",
    "playing.zoomCompact": "Compact",
    "playing.zoomNormal": "Normal",
    "playing.zoomLarge": "Large",
    "playing.refreshIn": "Refresh in {seconds}s",
    "playing.refreshNow": "Refreshing…",
    "playing.refreshLive": "Live",
} as const;

const fr: { [K in keyof typeof en]: string; } = {
    "search.placeholder": "Rechercher un ami ou un jeu",
    "search.placeholderRefine": "Affiner par nom",
    "search.aria": "Rechercher dans la liste d'amis",
    "search.clear": "Effacer",
    "search.filters": "Filtres",
    "search.emptyNoMatch": "Aucun ami ne correspond à cette recherche.",
    "search.emptyNoActivity": "Aucun ami n'a d'activité en cours.",
    "search.all": "Tous",
    "search.categoriesAria": "Catégories d'activité",

    "category.playing": "Jeux",
    "category.streaming": "Stream",
    "category.listening": "Écoute",
    "category.watching": "Regarde",
    "category.competing": "Compétition",
    "category.other": "Autre",

    "playing.section": "En jeu",
    "playing.join": "Rejoindre",
    "playing.joinNamed": "Rejoindre {name}",
    "playing.joinUnavailable": "Rejoindre indisponible pour ce jeu",
    "playing.viewProfile": "Voir le profil de {name}",
    "playing.emptyTitle": "Aucun ami ne joue pour le moment.",
    "playing.emptyHint": "Les jeux en cours apparaîtront ici dès qu'un ami lance une activité.",
    "playing.friendOne": "1 ami",
    "playing.friendMany": "{count} amis",
    "playing.zoomCaption": "Taille",
    "playing.zoomAria": "Taille des cartes de jeux",
    "playing.zoomCompact": "Compact",
    "playing.zoomNormal": "Normal",
    "playing.zoomLarge": "Grand",
    "playing.refreshIn": "Refresh dans {seconds}s",
    "playing.refreshNow": "Actualisation…",
    "playing.refreshLive": "En direct",
};

const messages = { en, fr } as const;

export type MessageKey = keyof typeof en;

function readDiscordLocale(): string {
    try {
        return LocaleStore.locale ?? "en";
    } catch {
        return "en";
    }
}

/** Map Discord client locale → plugin language (fr* → fr, en* → en, else en). */
export function resolveLang(locale = readDiscordLocale()): PluginLang {
    const code = locale.toLowerCase();
    if (code.startsWith("fr")) return "fr";
    if (code.startsWith("en")) return "en";
    return "en";
}

export function getLang(): PluginLang {
    return resolveLang();
}

/** BCP 47 tag for `localeCompare` / sorting. */
export function collatorLocale(): string {
    return getLang() === "fr" ? "fr" : "en";
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
    const lang = getLang();
    let text: string = messages[lang][key] ?? messages.en[key];
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replaceAll(`{${name}}`, String(value));
        }
    }
    return text;
}

/**
 * Subscribe to Discord {@link LocaleStore} so the UI re-renders when the client
 * language changes (no plugin restart). Discord itself may still reload the app
 * when the user switches language in settings.
 */
export function usePluginLang(): PluginLang {
    return useStateFromStores([LocaleStore], () => resolveLang());
}
