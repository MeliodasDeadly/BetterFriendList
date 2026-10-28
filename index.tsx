/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";

import { activityHaystack, matchesRow, ownsSearch, startSearchMount, stopSearchMount } from "./components/search";
import { t } from "./i18n";
import { settings } from "./settings";
import styles from "./styles/styles.css?managed";

const logger = new Logger("BetterFriendList");

export default definePlugin({
    name: "BetterFriendList",
    description: "Enhance the friend list by adding a playing section and filtering by search or activity type. / Améliore la liste d'amis avec une section En jeu et des filtres par recherche ou type d'activité.",
    authors: [{ name: "Meliodouil", id: BigInt(300589878972907520) }],
    tags: ["Friends", "Utility"],
    settings,
    managedStyle: styles,

    patches: [
        {
            find: "getRelationshipCounts(){",
            replacement: [
                {
                    match: /\}\)\.sortBy\((.+?)\)\.value\(\)/,
                    replace: "}).sortBy($1).value().filter((row,index,all)=>$self.matchesRow(row,index,all))"
                },
                {
                    match: /(\i)\.usernameLower\.includes\((\i)\)/,
                    replace: "($self.ownsSearch()||$1.usernameLower.includes($2))",
                    noWarn: true
                },
                {
                    match: /(\i)\.usernameLower\.indexOf\((\i)\)!==-1/,
                    replace: "($self.ownsSearch()||$1.usernameLower.indexOf($2)!==-1)",
                    noWarn: true
                }
            ]
        },
        {
            find: "#{intl::FRIENDS_SECTION_ONLINE}),className:",
            replacement: {
                match: /#{intl::FRIENDS_SECTION_ONLINE}\),className:(\i\.\i)(?=\})/,
                replace: '$&},{id:"PLAYING",show:!0,className:$1,content:$self.playingSectionLabel()'
            }
        },
        {
            find: '"FriendsStore"',
            replacement: {
                match: /case (\i\.\i)\.ONLINE:return(?=.{0,80}\.type.{0,80}case \1\.ALL)/,
                replace: 'case "PLAYING":case $1.ONLINE:return',
                noWarn: true
            }
        },
        {
            find: "FriendsEmptyState: Invalid empty state",
            replacement: {
                match: /case (\i\.\i)\.ONLINE:(?=return \i\.SECTION_ONLINE)/,
                replace: 'case "PLAYING":case $1.ONLINE:',
                noWarn: true
            }
        },
        {
            find: "#{intl::FRIENDS_ALL_HEADER}",
            replacement: {
                match: /case (\i\.\i)\.ONLINE:return/,
                replace: 'case "PLAYING":return $self.playingSectionLabel();case $1.ONLINE:return',
                noWarn: true
            }
        }
    ],

    start() {
        startSearchMount();
        logger.info("Started");
    },

    stop() {
        stopSearchMount();
        logger.info("Stopped");
    },

    matchesRow,
    activityHaystack,
    ownsSearch,
    playingSectionLabel: () => t("playing.section"),
});
