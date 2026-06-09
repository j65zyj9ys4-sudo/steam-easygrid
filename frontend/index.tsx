import { callable, findModule, sleep, Millennium, Menu, MenuItem, showContextMenu, DialogButton, showModal, SidebarNavigation, IconsModule, definePlugin, Field, TextField, Toggle } from "@steambrew/client";
import { createRoot } from "react-dom/client";
import React, { useState, useEffect } from "react";

declare global {
    var MainWindowBrowserManager: any;
    var appStore: any;
    var collectionStore: any;
    var uiStore: any;
}

// Backend callables
const call_api_backend = callable<[{ a_bearer: string, b_endpoint: string }], string>('call_api_backend');

// Returns true if the game has a native logo image on Steam's CDN.
// Text-only games (those that show a generated title instead of a logo image)
// return false. This is used to decide whether SetCustomLogoPositionForApp
// is needed to initialise the logo component.
const steamHasNativeLogo = async (appid: number): Promise<boolean> => {
    try {
        const r = await fetch(
            `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/logo.png`,
            { method: 'HEAD' }
        );
        return r.ok; // 200 = image logo exists, 404 = text-only game
    } catch {
        return false;
    }
};

const get_encoded_image = callable<[{ img_url: string }], string>('get_encoded_image');

const log_frontend = callable<[{ msg: string }], void>('log_frontend');
const set_animated_artwork = callable<[{ img_url: string, appid: number, imagetype: number }], string>('set_animated_artwork');
const check_artwork_ready = callable<[{ appid: number, imagetype: number, img_url: string }], string>('check_artwork_ready');
const apply_grid_artwork = callable<[{ appid: number, imagetype: number, img_url: string }], string>('apply_grid_artwork');
const get_preview_b64 = callable<[{ appid: number, imagetype: number, img_url: string }], string>('get_preview_b64');
const get_cache_filename = callable<[{ appid: number, imagetype: number, img_url: string }], string>('get_cache_filename');
const purge_game_cache = callable<[{ appid: number, imagetype: number }], string>('purge_game_cache');
const purge_all_cache = callable<[], string>('purge_all_cache');
const get_cached_anim_filename = callable<[{ appid: number, imagetype: number }], string>('get_cached_anim_filename');
const cache_logo = callable<[{ appid: number, img_url: string }], string>('cache_logo');

// Animated hero state
const HTTP_PORT = 27331;
const SGDB_OVERLAY_ID = 'sgdb-hero-anim-overlay';
const SGDB_REINSERT_KEY = '_sgdbReinsertInterval';
const SGDB_LOGO_OVERLAY_ID = 'sgdb-logo-overlay';
let libraryObserver: MutationObserver | null = null; // single observer, replaced on navigation
let currentPageAppId = 0; // tracks current game page to cancel stale animation timers

// Steam's hero is drawn on a <canvas> element. Setting CSS on canvas is invisible
// because the canvas paints over it. We instead insert our own <img> overlay on
// top of the canvas so the animated APNG shows correctly.
//
// MUST use popup.m_popup.document — the picker opens bForcePopOut:true (separate window)
// so global `document` is the picker window, not the library page.
const applyAnimatedHero = (popup: any, url: string | null): void => {
    try {
        const doc = popup?.m_popup?.document;
        if (!doc) return;

        // Early return if overlay already showing this URL with active maintenance
        if (url) {
            const curr = doc.getElementById(SGDB_OVERLAY_ID) as HTMLImageElement | null;
            if (curr?.src === url && (doc as any)[SGDB_REINSERT_KEY]) return;
        }

        // Synchronously stop and clean up — no delay, prevents leaking to other games
        if ((doc as any)[SGDB_REINSERT_KEY]) {
            clearInterval((doc as any)[SGDB_REINSERT_KEY]);
            delete (doc as any)[SGDB_REINSERT_KEY];
        }
        doc.getElementById(SGDB_OVERLAY_ID)?.remove();

        if (!url) return;

        const topCapsuleClass = findModule((m: any) => m.TopCapsule)?.TopCapsule;
        if (!topCapsuleClass) return;

        // Returns true if overlay was inserted, false if canvas not ready yet
        const insertOverlay = (): boolean => {
            // Already showing the right URL? Skip to avoid redundant inserts
            const existing = doc.getElementById(SGDB_OVERLAY_ID) as HTMLImageElement | null;
            if (existing?.src === url) return true;
            const tc = doc.querySelector(`div.${topCapsuleClass}`) as HTMLElement | null;
            if (!tc) return false;
            const canvas = tc.querySelector('canvas');
            if (!canvas) return false; // Canvas not in DOM yet — caller should retry
            doc.getElementById(SGDB_OVERLAY_ID)?.remove();
            // Anchor to tc (TopCapsule) not canvas.parentElement — tc spans the full
            // hero width so the overlay never leaves a gap on the right edge.
            if (getComputedStyle(tc).position === 'static') tc.style.position = 'relative';
            const overlay = doc.createElement('img') as HTMLImageElement;
            overlay.id = SGDB_OVERLAY_ID;
            overlay.src = url;
            overlay.style.cssText =
                'position:absolute!important;top:0!important;left:0!important;' +
                'width:100%!important;height:100%!important;' +
                'object-fit:cover!important;object-position:top center!important;' +
                'z-index:1!important;pointer-events:none!important;';
            tc.appendChild(overlay);
            log_frontend({ msg: `[sgdb] overlay inserted: ${url.substring(0, 60)}` });

            // Elevate every tc sibling above our z-index:1 overlay.
            // Previously used findModule(TitleSection) class lookup, but if that
            // returns null the logo is covered. Now that the overlay is a direct
            // child of tc (not a nested canvas container), any static-positioned
            // sibling is painted behind our absolute overlay — so just elevate
            // everything except our own overlays to z-index:2.
            try {
                Array.from(tc.children).forEach((child: Element) => {
                    const el = child as HTMLElement;
                    if (el.id === SGDB_OVERLAY_ID || el.id === SGDB_LOGO_OVERLAY_ID) return;
                    if (getComputedStyle(el).position === 'static')
                        el.style.setProperty('position', 'relative', 'important');
                    el.style.setProperty('z-index', '2', 'important');
                });
            } catch (_) {}
            return true;
        };

        // Try immediately; if canvas not ready, poll until it appears
        const startMaintenance = () => {
            (doc as any)[SGDB_REINSERT_KEY] = setInterval(() => {
                if (!doc.getElementById(SGDB_OVERLAY_ID)) insertOverlay();
            }, 600);
        };

        if (insertOverlay()) {
            startMaintenance();
        } else {
            // Canvas not ready — retry frequently until it appears
            (doc as any)[SGDB_REINSERT_KEY] = setInterval(() => {
                if (insertOverlay()) {
                    clearInterval((doc as any)[SGDB_REINSERT_KEY]);
                    startMaintenance();
                }
            }, 100);
        }

    } catch (err) {
        log_frontend({ msg: `[sgdb] applyAnimatedHero error: ${err}` });
    }
};


// Injects a logo image overlay positioned in the bottom-left of the hero area.
// No re-insert interval — logos don't need one (hero canvas does, logo element doesn't).
// The interval approach caused cross-game contamination: setInterval in the picker
// window (bForcePopOut) cannot be cancelled via clearInterval in the library window.
const applyLogoOverlay = (popup: any, url: string | null): void => {
    try {
        const doc = popup?.m_popup?.document;
        if (!doc) return;
        doc.getElementById(SGDB_LOGO_OVERLAY_ID)?.remove();
        if (!url) return;
        const topCapsuleClass = findModule((m: any) => m.TopCapsule)?.TopCapsule;
        if (!topCapsuleClass) return;
        const tc = doc.querySelector(`div.${topCapsuleClass}`) as HTMLElement | null;
        if (!tc) return;
        if (getComputedStyle(tc).position === 'static') tc.style.position = 'relative';
        const img = doc.createElement('img') as HTMLImageElement;
        img.id = SGDB_LOGO_OVERLAY_ID;
        img.src = url;
        img.style.cssText =
            'position:absolute!important;bottom:2rem!important;left:2rem!important;' +
            'max-height:184px!important;max-width:40%!important;' +
            'object-fit:contain!important;z-index:3!important;pointer-events:none!important;';
        tc.appendChild(img);
    } catch (_) {}
};

const WaitForElement = async (sel: string, parent = document) =>
	[...(await Millennium.findElement(parent, sel))][0];

const imgTypeDict = ["grids", "heroes", "logos", "wide_grids", "icons"];

type ImageTypeSubConfig = {
    nsfw: string,
    humor: string,
    epilepsy: string,
    types: string,
    mimes: string,
    styles: string,
    dimensions?: string
};

type PluginConfig = {
    api_key: string,
    display_name_fallback: boolean,
    replace_custom_images: boolean,
    appids_excluded_from_replacement: string,
    prioritize_animated: boolean,
    prioritize_authors: string[],
    expand_headers: string,
    app_page_button: boolean,
    collection_button: boolean,
    disable_webp: boolean,
    reapply_app_page: boolean,
    grids_config: ImageTypeSubConfig,
    wide_grids_config: ImageTypeSubConfig,
    heroes_config: ImageTypeSubConfig,
    logos_config: ImageTypeSubConfig,
    icons_config: ImageTypeSubConfig,
    icons_enabled: boolean,
    grids_width_mult: number,
    heroes_width_mult: number,
    logos_width_mult: number,
    icons_width_mult: number
};

var pluginConfig: PluginConfig = {
    api_key: "",
    display_name_fallback: true,
    replace_custom_images: true,
    appids_excluded_from_replacement: "",
    prioritize_animated: false,
    prioritize_authors: [],
    expand_headers: "",
    app_page_button: true,
    collection_button: true,
    disable_webp: true,
    reapply_app_page: true,
    grids_config: { nsfw: "false", humor: "any", epilepsy: "any", types: "static,animated", mimes: "image/webp,image/png,image/jpeg", styles: "alternate,blurred,white_logo,material,no_logo", dimensions: "600x900,342x482,660x930,512x512,1024x1024" },
    wide_grids_config: { nsfw: "false", humor: "any", epilepsy: "any", types: "static,animated", mimes: "image/webp,image/png,image/jpeg", styles: "alternate,blurred,white_logo,material,no_logo", dimensions: "460x215,920x430,512x512,1024x1024" },
    heroes_config: { nsfw: "false", humor: "any", epilepsy: "any", types: "static,animated", mimes: "image/webp,image/png,image/jpeg", styles: "alternate,blurred,material", dimensions: "" },
    logos_config: { nsfw: "false", humor: "any", epilepsy: "any", types: "static,animated", mimes: "image/webp,image/png", styles: "official,white,black,custom", dimensions: "" },
    icons_config: { nsfw: "false", humor: "any", epilepsy: "any", types: "static,animated", mimes: "image/png,image/vnd.microsoft.icon", styles: "official,custom", dimensions: "" },
    icons_enabled: false,
    grids_width_mult: 5,
    heroes_width_mult: 10,
    logos_width_mult: 7,
    icons_width_mult: 7
};

type GameIDOverrides = Record<string, number>;
var gameIDOverrides: GameIDOverrides = {};

type SearchCache = Record<string, Record<string, any>>;
var searchCache: SearchCache = {};

type AppCustomizationState = { grids: boolean; heroes: boolean; logos: boolean; wide_grids: boolean; icons: boolean; };
type CustomizationStates = Record<string, AppCustomizationState>;
var customizationStates: CustomizationStates = {};

function SetCustomizationState(appID: number, imgType: number, newState: boolean) {
    if (!(appID.toString() in customizationStates)) {
        customizationStates[appID.toString()] = { grids: false, heroes: false, logos: false, wide_grids: false, icons: false };
    }
    customizationStates[appID.toString()][imgTypeDict[imgType] as keyof AppCustomizationState] = newState;
    localStorage.setItem("luthor112.steam-easygrid.customization", JSON.stringify(customizationStates));
}

function GetCustomizationState(appID: number, imgType: number) {
    if (appID.toString() in customizationStates) {
        return customizationStates[appID.toString()][imgTypeDict[imgType] as keyof AppCustomizationState];
    }
    return false;
}

function getExcludedAppIDs() {
    let excludeAppsList = [];
    if (pluginConfig.appids_excluded_from_replacement !== "") {
        const strParts = pluginConfig.appids_excluded_from_replacement.split(";");
        for (let i = 0; i < strParts.length; i = i + 2) excludeAppsList.push(Number(strParts[i]));
    }
    return excludeAppsList;
}

async function callAPI(endpoint: string) {
    const apiAnswerStr = await call_api_backend({ a_bearer: pluginConfig.api_key, b_endpoint: endpoint });
    if (apiAnswerStr === "") { console.log("[steam-easygrid 4] Unsuccessful HTTP request"); return undefined; }
    let apiAnswer;
    try { apiAnswer = JSON.parse(apiAnswerStr); } catch (e) { console.error("[steam-easygrid 4] Failed to parse API response:", e); return undefined; }
    if ("http_status" in apiAnswer) { console.log("[steam-easygrid 4] Unsuccessful API call - HTTP", apiAnswer["http_status"]); return undefined; }
    else if (!("success" in apiAnswer)) { console.log("[steam-easygrid 4] Unsuccessful API call - Malformed answer"); return undefined; }
    else if (!apiAnswer["success"]) { console.log("[steam-easygrid 4] Unsuccessful API call - success is false"); return undefined; }
    else { console.log("[steam-easygrid 4] Successful API call"); return apiAnswer; }
}

async function getSteamGridDBId(appId: number): Promise<number | undefined> {
    if (appId.toString() in gameIDOverrides) return gameIDOverrides[appId.toString()];
    try {
        const gamesResponse = await callAPI(`games/steam/${appId}`);
        if (gamesResponse) {
            gameIDOverrides[appId.toString()] = gamesResponse["data"]["id"];
            localStorage.setItem("luthor112.steam-easygrid.overrides", JSON.stringify(gameIDOverrides));
            return gamesResponse["data"]["id"];
        } else if (pluginConfig.display_name_fallback) {
            const currentApp = appStore.allApps.find((x: any) => x.appid === appId);
            if (!currentApp) return undefined;
            const searchResponse = await callAPI(`search/autocomplete/${encodeURIComponent(currentApp.display_name)}`);
            if (searchResponse && searchResponse["data"].length > 0) {
                gameIDOverrides[appId.toString()] = searchResponse["data"][0]["id"];
                localStorage.setItem("luthor112.steam-easygrid.overrides", JSON.stringify(gameIDOverrides));
                return searchResponse["data"][0]["id"];
            }
        }
        return undefined;
    } catch (e) { console.error("[steam-easygrid 4] Failed to get SteamGridDB ID:", e); return undefined; }
}

async function searchAllPages(appId: number, imgType: number, typesOverride: string | undefined) {
    const gameId = await getSteamGridDBId(appId);
    if (!gameId) return [];
    const imgTypeName = imgTypeDict[imgType];
    const imgSearchTypeName = imgType === 3 ? "grids" : imgTypeName;
    const usedConfig = (pluginConfig[`${imgTypeName}_config` as keyof PluginConfig] as ImageTypeSubConfig);
    let fullResult: any[] = [];
    let mimeList = usedConfig.mimes;
    if (pluginConfig.disable_webp) mimeList = mimeList.replace("image/webp,", "").replace(",image/webp", "");
    let qString = `nsfw=${usedConfig.nsfw}&humor=${usedConfig.humor}&epilepsy=${usedConfig.epilepsy}&mimes=${mimeList}&styles=${usedConfig.styles}`;
    qString += typesOverride ? `&types=${typesOverride}` : `&types=${usedConfig.types}`;
    if ("dimensions" in usedConfig && usedConfig["dimensions"]) qString += `&dimensions=${usedConfig.dimensions}`;
    let page = 0;
    while (true) {
        const searchResult = await callAPI(`${imgSearchTypeName}/game/${gameId}?${qString}&page=${page}`);
        if (searchResult && searchResult["data"].length > 0) {
            fullResult = fullResult.concat(searchResult["data"]);
            if (searchResult["data"].length < 50) break;
            page++;
        } else break;
    }
    return fullResult;
}

function orderSearchDataByAuthors(searchData: any[]): any[] {
    const priorityAuthors: string[] = pluginConfig.prioritize_authors;
    if (priorityAuthors.length > 0) {
        searchData.sort((a, b) => {
            const aIdx = priorityAuthors.findIndex(author => a.author?.name?.toLowerCase() === author.toLowerCase());
            const bIdx = priorityAuthors.findIndex(author => b.author?.name?.toLowerCase() === author.toLowerCase());
            return (aIdx === -1 ? priorityAuthors.length : aIdx) - (bIdx === -1 ? priorityAuthors.length : bIdx);
        });
    }
    return searchData;
}

async function getSearchData(appId: number, imgType: number) {
    if (!(appId.toString() in searchCache)) searchCache[appId.toString()] = {};
    if (imgTypeDict[imgType] in searchCache[appId.toString()]) return searchCache[appId.toString()][imgTypeDict[imgType]];
    let searchData: any[] = [];
    if (pluginConfig.prioritize_animated) {
        let anim = await searchAllPages(appId, imgType, "animated");
        anim.forEach(x => x["type"] = "animated");
        anim = orderSearchDataByAuthors(anim);
        let stat = await searchAllPages(appId, imgType, "static");
        stat.forEach(x => x["type"] = "static");
        stat = orderSearchDataByAuthors(stat);
        searchData = anim.concat(stat);
    } else {
        searchData = await searchAllPages(appId, imgType, undefined);
        const animOnly = await searchAllPages(appId, imgType, "animated");
        searchData.forEach(x => { x["type"] = animOnly.find((a: any) => a.id === x.id) ? "animated" : "static"; });
        searchData = orderSearchDataByAuthors(searchData);
    }
    searchCache[appId.toString()][imgTypeDict[imgType]] = searchData;
    return searchData;
}

function getImageExtFromUrl(imgURL: string): 'jpg' | 'png' {
    return imgURL.endsWith(".jpg") || imgURL.endsWith(".jpeg") || imgURL.endsWith(".jfif") ? 'jpg' : 'png';
}

async function applyFirstWorkingImage(appId: number, imgType: number): Promise<boolean> {
    const gameId = await getSteamGridDBId(appId);
    if (!gameId) return false;
    const imgTypeName = imgTypeDict[imgType];
    const imgSearchTypeName = imgType === 3 ? "grids" : imgTypeName;
    const usedConfig = pluginConfig[`${imgTypeName}_config` as keyof PluginConfig] as ImageTypeSubConfig;
    let mimeList = usedConfig.mimes;
    if (pluginConfig.disable_webp) mimeList = mimeList.replace("image/webp,", "").replace(",image/webp", "");
    const dimStr = ("dimensions" in usedConfig && usedConfig["dimensions"]) ? `&dimensions=${usedConfig.dimensions}` : "";
    const baseQ = `nsfw=${usedConfig.nsfw}&humor=${usedConfig.humor}&epilepsy=${usedConfig.epilepsy}&mimes=${mimeList}&styles=${usedConfig.styles}${dimStr}`;
    const tryTypes = async (types: string): Promise<boolean> => {
        for (let page = 0; ; page++) {
            const result = await callAPI(`${imgSearchTypeName}/game/${gameId}?${baseQ}&types=${types}&page=${page}`);
            if (!result?.data?.length) return false;
            for (const item of result.data) {
                const imageData = await get_encoded_image({ img_url: item.url });
                if (imageData) { SteamClient.Apps.SetCustomArtworkForApp(appId, imageData, getImageExtFromUrl(item.url), imgType); SetCustomizationState(appId, imgType, true); return true; }
            }
            if (result.data.length < 50) return false;
        }
    };
    if (pluginConfig.prioritize_animated) return await tryTypes("animated") || await tryTypes("static");
    return await tryTypes(usedConfig.types);
}

async function getImageData(appId: number, imgType: number, imgNum: number) {
    await log_frontend({ msg: `getImageData appid=${appId} type=${imgType} index=${imgNum}` });
    const searchResults = await getSearchData(appId, imgType);
    await log_frontend({ msg: `image list length=${searchResults ? searchResults.length : null}` });
    if (searchResults && searchResults.length > imgNum) {
        const imgURL = searchResults[imgNum].url;
        await log_frontend({ msg: `requesting via backend url=${imgURL}` });
        if (imgURL.toLowerCase().includes('.webp')) {
            const result = await set_animated_artwork({ img_url: imgURL, appid: appId, imagetype: imgType });
            await log_frontend({ msg: `animated result=${result}` });
            if (result && result.includes('CACHED')) return 'WAIT_CACHED';   // already on disk
            if (result && result.includes('CONVERTING')) return 'WAIT_CONVERTING'; // needs conversion
            if (result && result.includes('FAILED')) return undefined;
        }
        // Download via Lua curl → Python compress → get_preview_b64.
        // Static PNG/JPG: download and base64-encode in Lua, return directly.
        // No Python, no compression, no daemonizing — same proven path as logos.
        await log_frontend({ msg: `[static] downloading ${imgURL}` });
        const b64raw = await get_encoded_image({ img_url: imgURL });
        const b64 = (b64raw || '').replace(/[^A-Za-z0-9+/=]/g, '');
        await log_frontend({ msg: `[static] encoded ${b64.length} chars` });
        return b64 || undefined;
    }
    return undefined;
}

async function getImageExt(appId: number, imgType: number, imgNum: number) {
    const searchResults = await getSearchData(appId, imgType);
    if (searchResults && searchResults.length > imgNum) {
        const imgURL = searchResults[imgNum].url;
        return (imgURL.endsWith(".jpg") || imgURL.endsWith(".jpeg") || imgURL.endsWith(".jfif")) ? 'jpg' : 'png';
    }
    return undefined;
}

async function renderHome(popup: any) {
    const headerDiv = await WaitForElement(`div.${findModule(e => e.ShowcaseHeader).ShowcaseHeader}`, popup.m_popup.document);
    const oldGridButton = headerDiv.querySelector('button.easygrid-button');
    if (!oldGridButton && pluginConfig.collection_button) {
        const gridButton = popup.m_popup.document.createElement("div");
        const gridButtonRoot = createRoot(gridButton);
        gridButtonRoot.render(<DialogButton className="easygrid-button" style={{width: "50px"}}>SGDB</DialogButton>);
        headerDiv.insertBefore(gridButton, headerDiv.firstChild!.nextSibling!.nextSibling);
        gridButton.addEventListener("click", async () => {
            const extraMenuItems = [];
            for (let i = 0; i < collectionStore.userCollections.length; i++) {
                const collId = collectionStore.userCollections[i].m_strId;
                const collName = collectionStore.userCollections[i].m_strName;
                extraMenuItems.push(<MenuItem onClick={async () => {
                    const currentColl = collectionStore.GetCollection(collId);
                    const excludedAppIDs = getExcludedAppIDs();
                    for (let j = 0; j < currentColl.allApps.length; j++) {
                        gridButton.firstChild.innerHTML = `Working... (${j}/${currentColl.allApps.length})`;
                        const appid = currentColl.allApps[j].appid;
                        if (appid in excludedAppIDs) continue;
                        if (!pluginConfig.replace_custom_images && GetCustomizationState(appid, 0)) continue;
                        await applyFirstWorkingImage(appid, 0);
                        delete searchCache[appid.toString()];
                    }
                    gridButton.firstChild.innerHTML = "Done!";
                }}> Replace grids of {collName} </MenuItem>);
                extraMenuItems.push(<MenuItem onClick={async () => {
                    const currentColl = collectionStore.GetCollection(collId);
                    for (let j = 0; j < currentColl.allApps.length; j++) {
                        gridButton.firstChild.innerHTML = `Working... (${j}/${currentColl.allApps.length})`;
                        SteamClient.Apps.ClearCustomArtworkForApp(currentColl.allApps[j].appid, 0);
                        SetCustomizationState(currentColl.allApps[j].appid, 0, false);
                    }
                    gridButton.firstChild.innerHTML = "Done!";
                }}> Reset grids of {collName} </MenuItem>);
            }
            showContextMenu(<Menu label="EasyGrid Options">{extraMenuItems}</Menu>, gridButton, {bForcePopup: true});
        });
    }
}

async function renderCollection(popup: any) {
    const collOptionsDiv = await WaitForElement(`div.${findModule(e => e.CollectionOptions).CollectionOptions}`, popup.m_popup.document);
    const oldGridButton = collOptionsDiv.querySelector('button.easygrid-button');
    if (!oldGridButton && pluginConfig.collection_button) {
        const gridButton = popup.m_popup.document.createElement("div");
        const gridButtonRoot = createRoot(gridButton);
        gridButtonRoot.render(<DialogButton className="easygrid-button" style={{width: "50px"}}>SGDB</DialogButton>);
        collOptionsDiv.insertBefore(gridButton, collOptionsDiv.firstChild!.nextSibling);
        gridButton.addEventListener("click", async () => {
            showContextMenu(
                <Menu label="EasyGrid Options">
                    <MenuItem onClick={async () => {
                        const currentColl = collectionStore.GetCollection(uiStore.currentGameListSelection.strCollectionId);
                        const excludedAppIDs = getExcludedAppIDs();
                        for (let j = 0; j < currentColl.allApps.length; j++) {
                            gridButton.firstChild.innerHTML = `Working... (${j}/${currentColl.allApps.length})`;
                            const appid = currentColl.allApps[j].appid;
                            if (appid in excludedAppIDs) continue;
                            if (!pluginConfig.replace_custom_images && GetCustomizationState(appid, 0)) continue;
                            await applyFirstWorkingImage(appid, 0);
                            delete searchCache[appid.toString()];
                        }
                        gridButton.firstChild.innerHTML = "Done!";
                    }}> Replace grids </MenuItem>
                    <MenuItem onClick={async () => {
                        const currentColl = collectionStore.GetCollection(uiStore.currentGameListSelection.strCollectionId);
                        for (let j = 0; j < currentColl.allApps.length; j++) {
                            gridButton.firstChild.innerHTML = `Working... (${j}/${currentColl.allApps.length})`;
                            SteamClient.Apps.ClearCustomArtworkForApp(currentColl.allApps[j].appid, 0);
                            SetCustomizationState(currentColl.allApps[j].appid, 0, false);
                        }
                        gridButton.firstChild.innerHTML = "Done!";
                    }}> Reset grids </MenuItem>
                </Menu>,
                gridButton, {bForcePopup: true}
            );
        });
    }
}

type GetEasyGridComponentProps = { appid: number; appname: string; imagetype: number; imageWidthMult: number; };

function getEasyGridComponent(popup: any) {
    return (props: GetEasyGridComponentProps) => {
        const containerStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', overflowX: 'hidden', overflowY: 'auto', padding: '10px', gap: '10px', width: '100%' };
        const imageWrapperStyle: React.CSSProperties = { width: (popup.m_popup.window.screen.width * props.imageWidthMult) + 'px', minWidth: "150px", height: "auto", position: 'relative', display: 'inline-block' };
        const imageStyle: React.CSSProperties = { width: '100%', height: 'auto', objectFit: 'cover', borderRadius: '8px', display: 'block' };
        const statusStyle: React.CSSProperties = { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'darkgray', fontSize: '24px', fontWeight: 'bold' };

        const [steamGridDBId, setSteamGridDBId] = useState<number>(-1);
        const [thumbnailList, setThumbnailList] = useState([]);
        const [sgdbIdInput, setSteamGridDBIdInput] = useState<string>("");

        const GetCurrentSettings = async () => {
            const id = await getSteamGridDBId(props.appid);
            setSteamGridDBId(id !== undefined ? id : -1);
            setSteamGridDBIdInput(id !== undefined ? id.toString() : "");
            setThumbnailList(await getSearchData(props.appid, props.imagetype));
        };

        const PurgeImageCache = async () => {
            console.log("[steam-easygrid 4] Purging cache and reloading...");
            searchCache[props.appid.toString()] = {};
            await purge_game_cache({ appid: props.appid, imagetype: props.imagetype });
            // stop animation on purge (no popup ref here, interval cleared on next applyAnimatedHero call)
            GetCurrentSettings();
        };

        const SetSteamGridDBIdOverride = async () => {
            const newId = Number(sgdbIdInput);
            if (!isNaN(newId) && newId > 0) {
                gameIDOverrides[props.appid.toString()] = newId;
                localStorage.setItem("luthor112.steam-easygrid.overrides", JSON.stringify(gameIDOverrides));
                searchCache[props.appid.toString()] = {};
                GetCurrentSettings();
            }
        };

        const ClearSteamGridDBIdOverride = async () => {
            delete gameIDOverrides[props.appid.toString()];
            localStorage.setItem("luthor112.steam-easygrid.overrides", JSON.stringify(gameIDOverrides));
            searchCache[props.appid.toString()] = {};
            GetCurrentSettings();
        };

        const SetNewImage = async (e: React.MouseEvent<HTMLElement>) => {
            const targetNum = Number((e.target as HTMLElement).dataset.imageindex);
            console.log("[steam-easygrid 4] Setting image to:", targetNum);
            const statusEl = (e.target as HTMLElement).nextElementSibling as HTMLElement;
            // Subtle white glow for readability over varied hero backgrounds
            statusEl.style.textShadow = '0 0 6px rgba(255,255,255,0.9), 0 0 14px rgba(255,255,255,0.5)';
            statusEl.style.setProperty('-webkit-text-stroke', '1.5px white');
            statusEl.style.setProperty('paint-order', 'stroke fill');
            statusEl.innerText = "DOWNLOADING";
            statusEl.style.color = 'darkgray';
            statusEl.style.textShadow = '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff';

            // ── LOGO (static PNG/JPG): clean Lua download pipeline ──────────────────
            // Animated WebP logos fall through to the existing APNG conversion pipeline.
            if (props.imagetype === 2) {
                const logoResults = await getSearchData(props.appid, props.imagetype);
                const logoImgURL = logoResults?.[targetNum]?.url ?? '';
                if (!logoImgURL) {
                    statusEl.innerText = "FAILED";
                    statusEl.style.color = 'darkred';
                    return;
                }
                if (!logoImgURL.toLowerCase().includes('.webp')) {
                    const b64raw = await get_encoded_image({ img_url: logoImgURL });
                    const b64 = (b64raw || '').replace(/[^A-Za-z0-9+/=]/g, '');
                    if (b64) {
                        SteamClient.Apps.SetCustomArtworkForApp(props.appid, b64, 'png', 2);
                        // For text-only games (no Steam CDN logo image), SetCustomArtworkForApp
                        // alone doesn't render the logo — SetCustomLogoPositionForApp is required
                        // to initialise the logo component. CDN-logo games don't need it.
                        const hasNative = await steamHasNativeLogo(props.appid);
                        if (!hasNative) {
                            (SteamClient.Apps as any).SetCustomLogoPositionForApp?.(
                                props.appid,
                                JSON.stringify({
                                    nVersion: 1,
                                    logoPosition: { pinnedPosition: "BottomLeft", nWidthPct: 39, nHeightPct: 31 }
                                })
                            );
                        }
                        SetCustomizationState(props.appid, 2, true);
                        statusEl.innerText = "DONE✓";
                        statusEl.style.color = 'darkgreen';
                        cache_logo({ appid: props.appid, img_url: logoImgURL }).catch(() => {});
                    } else {
                        statusEl.innerText = "FAILED";
                        statusEl.style.color = 'darkred';
                    }
                    return;
                }
                // Animated WebP logo: fall through to existing APNG pipeline below
            }
            // ── END LOGO INTERCEPT ────────────────────────────────────────────────────

            const newImage = await getImageData(props.appid, props.imagetype, targetNum);
            if (newImage) {
                if (newImage === 'WAIT_CACHED' || newImage === 'WAIT_CONVERTING') {
                    const isCached = newImage === 'WAIT_CACHED';
                    statusEl.innerText = isCached ? "APPLYING..." : "CONVERTING...";
                    statusEl.style.color = 'darkorange';
                    const searchResults = await getSearchData(props.appid, props.imagetype);
                    const imgURL = searchResults![targetNum].url;
                    let ready = false;
                    if (isCached) {
                        // File already on disk — check once immediately, no delay
                        const status = await check_artwork_ready({ appid: props.appid, imagetype: props.imagetype, img_url: imgURL });
                        ready = !!(status && status.includes('READY'));
                    } else {
                        // Conversion in progress — poll with 5s interval
                        for (let i = 0; i < 120; i++) {
                            await new Promise(r => setTimeout(r, 5000));
                            const status = await check_artwork_ready({ appid: props.appid, imagetype: props.imagetype, img_url: imgURL });
                            if (status && status.includes('READY')) { ready = true; break; }
                        }
                    }
                    if (ready) {
                        statusEl.innerText = "APPLYING...";
                        statusEl.style.color = 'darkorange';
                        // Show first frame immediately via SetCustomArtworkForApp (no restart needed)
                        const previewB64 = await get_preview_b64({ appid: props.appid, imagetype: props.imagetype, img_url: imgURL });
                        const cleanPreview = (previewB64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
                        if (cleanPreview.length > 0) {
                            SteamClient.Apps.SetCustomArtworkForApp(props.appid, cleanPreview, 'png', props.imagetype);
                        }
                        // Copy full APNG to grid folder for persistence across restarts
                        const result = await apply_grid_artwork({ appid: props.appid, imagetype: props.imagetype, img_url: imgURL });
                        if (result && result.includes('OK')) {
                            SetCustomizationState(props.appid, props.imagetype, true);
                            statusEl.innerText = "DONE✓";
                            statusEl.style.color = 'darkgreen';
                            // Apply animated APNG overlay — only needed for animated WebP heroes.
                            // Static PNG heroes are handled natively by Steam once SetCustomArtworkForApp
                            // and apply_grid_artwork run; no DOM overlay needed.
                            if (props.imagetype === 1 && imgURL.toLowerCase().includes('.webp')) {
                                const filename = await get_cache_filename({ appid: props.appid, imagetype: props.imagetype, img_url: imgURL });
                                const cleanFilename = (filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
                                if (cleanFilename) {
                                    const animUrl = `http://localhost:${HTTP_PORT}/${cleanFilename}`;
                                    setTimeout(() => applyAnimatedHero(popup, animUrl), 600);
                                }
                            } else if (props.imagetype === 2) {
                                // For text-only games, set position to initialise the logo component
                                steamHasNativeLogo(props.appid).then(hasNative => {
                                    if (!hasNative) {
                                        (SteamClient.Apps as any).SetCustomLogoPositionForApp?.(
                                            props.appid,
                                            JSON.stringify({
                                                nVersion: 1,
                                                logoPosition: { pinnedPosition: "BottomLeft", nWidthPct: 39, nHeightPct: 31 }
                                            })
                                        );
                                    }
                                });
                            }
                        } else {
                            statusEl.innerText = "FAILED";
                            statusEl.style.color = 'darkred';
                        }
                    } else {
                        statusEl.innerText = "FAILED";
                        statusEl.style.color = 'darkred';
                    }
                } else {
                    const imageExt = await getImageExt(props.appid, props.imagetype, targetNum);
                    SteamClient.Apps.SetCustomArtworkForApp(props.appid, newImage, imageExt!, props.imagetype);
                    SetCustomizationState(props.appid, props.imagetype, true);

                    statusEl.innerText = "DONE✓";
                    statusEl.style.color = 'darkgreen';
                }
            } else {
                statusEl.innerText = "FAILED";
                statusEl.style.color = 'darkred';
            }
        };

        const SetOriginalImage = async () => {
            console.log("[steam-easygrid 4] Resetting image...");
            SteamClient.Apps.ClearCustomArtworkForApp(props.appid, props.imagetype);
            SetCustomizationState(props.appid, props.imagetype, false);
            applyAnimatedHero(popup, null);
            applyLogoOverlay(popup, null);
        };

        const ResetAllImages = async () => {
            // Clear ALL custom artwork for ALL tracked games and image types
            const all: CustomizationStates = JSON.parse(
                localStorage.getItem("luthor112.steam-easygrid.customization") || "{}"
            );
            for (const appIdStr of Object.keys(all)) {
                const id = parseInt(appIdStr);
                for (let t = 0; t <= 4; t++) {
                    if (all[appIdStr][imgTypeDict[t] as keyof AppCustomizationState])
                        SteamClient.Apps.ClearCustomArtworkForApp(id, t);
                }
            }
            customizationStates = {};
            localStorage.setItem("luthor112.steam-easygrid.customization", "{}");
            applyAnimatedHero(popup, null);
        };

        const PurgeAllDiskCache = async () => {
            await purge_all_cache();
            searchCache = {};
        };

        const OpenWebpage = async () => {
            console.log("[steam-easygrid 4] Opening SGDB Webpage...");
            window.open(`https://www.steamgriddb.com/game/${steamGridDBId}`, "_blank");
        };

        useEffect(() => { GetCurrentSettings(); }, []);

        return (
            <div>
                App ID: {props.appid} / SGDB ID: {steamGridDBId} / Image Type: {props.imagetype} (found {thumbnailList.length}) <br/>
                <DialogButton style={{width: "90px",  display: "inline-block"}} onClick={SetOriginalImage}>Reset</DialogButton> &nbsp;
                <DialogButton style={{width: "110px", display: "inline-block"}} onClick={PurgeImageCache}>Clear Cache</DialogButton> &nbsp;
                <DialogButton style={{width: "125px", display: "inline-block"}} onClick={OpenWebpage}>Open Webpage</DialogButton> &nbsp;
                <DialogButton style={{width: "100px", display: "inline-block"}} onClick={ResetAllImages}>Reset All</DialogButton> &nbsp;
                <DialogButton style={{width: "130px", display: "inline-block"}} onClick={PurgeAllDiskCache}>Purge All Cache</DialogButton>
                <div style={{width: "130px", display: "inline-block", marginLeft: "8px", marginRight: "4px", verticalAlign: "middle"}}>
                    <TextField value={sgdbIdInput} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSteamGridDBIdInput(e.currentTarget.value)} mustBeNumeric={true} />
                </div>
                <DialogButton style={{width: "100px", display: "inline-block"}} onClick={SetSteamGridDBIdOverride}>Set SGDB ID</DialogButton> &nbsp;
                <DialogButton style={{width: "115px", display: "inline-block"}} onClick={ClearSteamGridDBIdOverride}>Clear SGDB ID</DialogButton><br/>
                <div style={containerStyle}>
                    {thumbnailList.map((thumbData, index) => {
                        if (thumbData["type"] === "static")
                            return (
                                <div style={imageWrapperStyle}>
                                    <img key={index} data-imageindex={index} src={thumbData["thumb"]} alt={thumbData["type"]} style={imageStyle} onClick={SetNewImage}/>
                                    <div key={`${index}-status`} style={statusStyle}></div>
                                </div>
                            );
                        return (
                            <div style={imageWrapperStyle}>
                                <video key={index} data-imageindex={index} autoPlay loop muted playsInline src={thumbData["thumb"]} title={thumbData["type"]} style={imageStyle} onClick={SetNewImage}/>
                                <div key={`${index}-status`} style={statusStyle}></div>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };
}

async function openSGDBWindow(popup: any) {
    const EasyGridComponent = getEasyGridComponent(popup);
    const currentColl = collectionStore.GetCollection(uiStore.currentGameListSelection.strCollectionId);
    const currentApp = currentColl.allApps.find((x: any) => x.appid === uiStore.currentGameListSelection.nAppId);
    const heroWidthMult = pluginConfig.heroes_width_mult / 100;
    const logoWidthMult = pluginConfig.logos_width_mult / 100;
    const gridWidthMult = pluginConfig.grids_width_mult / 100;
    const iconWidthMult = pluginConfig.icons_width_mult / 100;
    let modalPages = [
        {title: <div>Hero</div>, content: <EasyGridComponent key="hero_page" appid={uiStore.currentGameListSelection.nAppId} appname={currentApp.display_name} imagetype={1} imageWidthMult={heroWidthMult}/>},
        {title: <div>Logo</div>, content: <EasyGridComponent key="logo_page" appid={uiStore.currentGameListSelection.nAppId} appname={currentApp.display_name} imagetype={2} imageWidthMult={logoWidthMult}/>},
        {title: <div>Grid</div>, content: <EasyGridComponent key="grid_page" appid={uiStore.currentGameListSelection.nAppId} appname={currentApp.display_name} imagetype={0} imageWidthMult={gridWidthMult}/>},
        {title: <div>Wide Grid</div>, content: <EasyGridComponent key="widegrid_page" appid={uiStore.currentGameListSelection.nAppId} appname={currentApp.display_name} imagetype={3} imageWidthMult={gridWidthMult}/>}
    ];
    if (pluginConfig.icons_enabled) {
        modalPages.push({title: <div>Icon</div>, content: <EasyGridComponent key="icon_page" appid={uiStore.currentGameListSelection.nAppId} appname={currentApp.display_name} imagetype={4} imageWidthMult={iconWidthMult}/>});
    }
    showModal(
        <SidebarNavigation pages={modalPages} showTitle={true} title={currentApp.display_name}/>,
        popup.m_popup.window, {strTitle: "EasyGrid", bHideMainWindowForPopouts: false, bForcePopOut: true, popupHeight: 700, popupWidth: 1500}
    );
}

async function renderApp(popup: any) {
    const topCapsuleDiv = await WaitForElement(`div.${findModule(e => e.TopCapsule).TopCapsule}`, popup.m_popup.document);

    // Immediately clean up any previous animation (no delay — prevents cross-game leakage)
    applyAnimatedHero(popup, null);
    // Then re-apply if this specific game has an animation cached
    try {
        // m_lastLocation is what Steam uses for library navigation URLs —
        // popup.m_popup.window.location may not match the /library/app/ format
        const pathname = MainWindowBrowserManager?.m_lastLocation?.pathname ||
                         popup.m_popup.window?.location?.pathname || '';
        const appMatch = pathname.match(/\/app\/(\d+)/);
        if (appMatch) {
            const pageAppId = parseInt(appMatch[1]);
            currentPageAppId = pageAppId; // mark current page before any async work
            // Check disk cache directly — works across all JS contexts
            const cachedFilename = await get_cached_anim_filename({ appid: pageAppId, imagetype: 1 });
            const cleanCached = (cachedFilename || '').replace(/["\s]/g, '').trim();
            if (cleanCached) {
                const animUrl = `http://localhost:${HTTP_PORT}/${cleanCached}`;
                const capturedId = pageAppId;
                setTimeout(() => {
                    if (currentPageAppId === capturedId) applyAnimatedHero(popup, animUrl);
                }, 600);
            }

        }
    } catch (_) {}

    if (!topCapsuleDiv.classList.contains("easygrid-header")) {
        topCapsuleDiv.addEventListener("dblclick", async () => { openSGDBWindow(popup); });
        topCapsuleDiv.classList.add("easygrid-header");
    }

    if (pluginConfig.app_page_button) {
        const gameSettingsButton = await WaitForElement(`div.${findModule(e => e.InPage).InPage} div.${findModule(e => e.AppButtonsContainer).AppButtonsContainer} > div.${findModule(e => e.MenuButtonContainer).MenuButtonContainer}:not([role="button"])`, popup.m_popup.document);
        const oldGridButton = gameSettingsButton.parentNode!.querySelector('div.easygrid-button');
        if (!oldGridButton) {
            const gridButton = gameSettingsButton.cloneNode(true) as HTMLElement;
            gridButton.classList.add("easygrid-button");
            (gridButton.firstChild as HTMLElement)!.innerHTML = "SG";
            gameSettingsButton.parentNode!.insertBefore(gridButton, gameSettingsButton.nextSibling);
            gridButton.addEventListener("click", async () => {
                showContextMenu(
                    <Menu label="SGDB Options">
                        <MenuItem onClick={async () => {
                            const allImageTypes = pluginConfig.icons_enabled ? 5 : 4;
                            const appId = uiStore.currentGameListSelection.nAppId;
                            for (let j = 0; j < allImageTypes; j++) {
                                (gridButton.firstChild as HTMLElement)!.innerHTML = `${j}/${allImageTypes}`;
                                await applyFirstWorkingImage(appId, j);
                            }
                            (gridButton.firstChild as HTMLElement)!.innerHTML = "SG";
                        }}> Auto replace images </MenuItem>
                        <MenuItem onClick={async () => { openSGDBWindow(popup); }}> Open window </MenuItem>
                    </Menu>,
                    gridButton, { bForcePopup: true }
                );
            });
        }
    }

    if (pluginConfig.expand_headers !== "") {
        for (const el of popup.m_popup.document.querySelectorAll(`*:has(> .${findModule(e => e.ImgSrc).ImgSrc})`)) {
            el.style.setProperty("height", "auto", "important");
        }
        (topCapsuleDiv as HTMLElement).style.setProperty("max-height", pluginConfig.expand_headers, "important");
        for (const el of popup.m_popup.document.querySelectorAll(`.${findModule(e => e.BoxSizer).BoxSizer} img`)) {
            el.style.setProperty("width", "50%", "important");
            el.style.setProperty("height", "50%", "important");
            el.style.setProperty("margin-bottom", "100px", "important");
        }
        for (const el of popup.m_popup.document.querySelectorAll(`.${findModule(e => e.TitleSection).TitleSection}`)) {
            el.style.setProperty("bottom", "100px", "important");
        }
    }
}

async function renderAppAndObserve(popup: any) {
    await renderApp(popup);
    if (pluginConfig.reapply_app_page) {
        // Disconnect previous observer — prevents accumulation across navigations
        // which would cause multiple simultaneous renderApp calls
        if (libraryObserver) { libraryObserver.disconnect(); libraryObserver = null; }
        const topCapsuleDiv = await WaitForElement(`div.${findModule(e => e.TopCapsule).TopCapsule}`, popup.m_popup.document);
        libraryObserver = new MutationObserver(async (mutations) => {
            // Ignore DOM changes caused by our own overlay to prevent cleanup loop
            const causedByOurOverlay = mutations.every(m =>
                [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)]
                    .every(n => {
                        const id = (n as Element)?.id;
                        return id === SGDB_OVERLAY_ID || id === SGDB_LOGO_OVERLAY_ID;
                    })
            ); // SGDB_LOGO_OVERLAY_ID included so logo cleanup doesn't retrigger renderApp
            if (!causedByOurOverlay) await renderApp(popup);
        });
        libraryObserver.observe(topCapsuleDiv.parentNode!, { subtree: true, childList: true, attributes: true });
    }
}

async function OnPopupCreation(popup: any) {
    await sleep(10000);
    if (popup.m_strName === "SP Desktop_uid0") {
        var mwbm = undefined;
        while (!mwbm) {
            console.log("[steam-easygrid 4] Waiting for MainWindowBrowserManager");
            try { mwbm = MainWindowBrowserManager; } catch { await sleep(100); }
        }
        console.log("[steam-easygrid 4] Registering callback");
        MainWindowBrowserManager.m_browser.on("finished-request", async (currentURL: any, previousURL: any) => {
            void currentURL; void previousURL;
            if (MainWindowBrowserManager.m_lastLocation.pathname === "/library/home") {
                await renderHome(popup);
            } else if (MainWindowBrowserManager.m_lastLocation.pathname.startsWith("/library/collection/")) {
                await renderCollection(popup);
            } else if (MainWindowBrowserManager.m_lastLocation.pathname.startsWith("/library/app/")) {
                await renderAppAndObserve(popup);
            }
        });
    }
}

type BoolKeys = { [K in keyof PluginConfig]: PluginConfig[K] extends boolean ? K : never }[keyof PluginConfig];
type StringKeys = { [K in keyof PluginConfig]: PluginConfig[K] extends string ? K : never }[keyof PluginConfig];
type NumKeys = { [K in keyof PluginConfig]: PluginConfig[K] extends number ? K : never }[keyof PluginConfig];
type StringArrayKeys = { [K in keyof PluginConfig]: PluginConfig[K] extends string[] ? K : never }[keyof PluginConfig];

type SingleSettingProps =
  | { type: "bool"; name: BoolKeys; label: string; description: string; readonly?: boolean }
  | { type: "text"; name: StringKeys; label: string; description: string; readonly?: boolean }
  | { type: "num"; name: NumKeys; label: string; description: string; readonly?: boolean }
  | { type: "textchild"; name: keyof ImageTypeSubConfig; parentname: keyof PluginConfig; label: string; description: string; readonly?: boolean }
  | { type: "array"; name: StringArrayKeys; label: string; description: string; readonly?: boolean };

const SingleSetting = (props: SingleSettingProps) => {
    const [boolValue, setBoolValue] = useState(false);
    const [isDisabled, setIsDisabled] = useState(false);
    const saveConfig = () => { localStorage.setItem("luthor112.steam-easygrid.config", JSON.stringify(pluginConfig)); searchCache = {}; };
    useEffect(() => {
        if (props.type === "bool") setBoolValue(pluginConfig[props.name]);
        if (props.readonly) setIsDisabled(true);
    }, []);
    if (props.type === "bool") {
        return (<Field label={props.label} description={props.description} bottomSeparator="standard" focusable><Toggle disabled={isDisabled} value={boolValue} onChange={(value) => { setBoolValue(value); pluginConfig[props.name] = value; saveConfig(); }} /></Field>);
    } else if (props.type === "text") {
        return (<Field label={props.label} description={props.description} bottomSeparator="standard" focusable><TextField disabled={isDisabled} defaultValue={pluginConfig[props.name]} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { pluginConfig[props.name] = e.currentTarget.value; saveConfig(); }} /></Field>);
    } else if (props.type === "num") {
        return (<Field label={props.label} description={props.description} bottomSeparator="standard" focusable><TextField disabled={isDisabled} mustBeNumeric={true} defaultValue={pluginConfig[props.name].toString()} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { pluginConfig[props.name] = Number(e.currentTarget.value); saveConfig(); }} /></Field>);
    } else if (props.type === "textchild") {
        return (<Field label={props.label} description={props.description} bottomSeparator="standard" focusable><TextField disabled={isDisabled} defaultValue={(pluginConfig[props.parentname] as ImageTypeSubConfig)[props.name]} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { (pluginConfig[props.parentname] as ImageTypeSubConfig)[props.name] = e.currentTarget.value; saveConfig(); }} /></Field>);
    } else if (props.type === "array") {
        return (<Field label={props.label} description={props.description} bottomSeparator="standard" focusable><TextField disabled={isDisabled} defaultValue={pluginConfig[props.name].join(", ")} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { pluginConfig[props.name] = e.currentTarget.value.split(",").map(s => s.trim()).filter(s => s.length > 0); saveConfig(); }} /></Field>);
    }
    return (<div>This should not happen...</div>);
};

type ImageSearchSettingProps = { name: keyof PluginConfig; label: string; };
const ImageSearchSetting = (props: ImageSearchSettingProps) => (
    <div>
        <SingleSetting name="nsfw" parentname={props.name} type="textchild" label={`${props.label} :: nsfw`} description="any | true | false" />
        <SingleSetting name="humor" parentname={props.name} type="textchild" label={`${props.label} :: humor`} description="any | true | false" />
        <SingleSetting name="epilepsy" parentname={props.name} type="textchild" label={`${props.label} :: epilepsy`} description="any | true | false" />
        <SingleSetting name="types" parentname={props.name} type="textchild" label={`${props.label} :: types`} description="Comma separated" />
        <SingleSetting name="mimes" parentname={props.name} type="textchild" label={`${props.label} :: mimes`} description="Comma separated" />
        <SingleSetting name="styles" parentname={props.name} type="textchild" label={`${props.label} :: styles`} description="Comma separated" />
        <SingleSetting name="dimensions" parentname={props.name} type="textchild" label={`${props.label} :: dimensions`} description="Comma separated" />
    </div>
);

const SettingsContent = () => {
    const [clearing, setClearing] = React.useState(false);
    const doClearAll = async () => { setClearing(true); await purge_all_cache(); setClearing(false); };
    return (
        <div>
            <Field label="Clear All Animation Cache" description="Delete all downloaded/converted APNG files from disk">
                <DialogButton onClick={doClearAll} disabled={clearing} style={{width: '160px'}}>{clearing ? 'Clearing...' : 'Clear All Cache'}</DialogButton>
            </Field>
            <SingleSetting name="api_key" type="text" label="API key" description="Your SteamGridDB API key" />
            <SingleSetting name="display_name_fallback" type="bool" label="Search by name fallback" description="Fallback to searching by name if needed" />
            <SingleSetting name="replace_custom_images" type="bool" label="Always replace custom Images" description="When replacing all grid images, replace custom set ones as well" />
            <SingleSetting name="appids_excluded_from_replacement" type="text" label="Exclude APPIDs from replacement" description="When replacing all grid images, skip these apps (separate by semicolon)" />
            <SingleSetting name="prioritize_animated" type="bool" label="Prioritize animated images" description="Prioritize animated images" />
            <SingleSetting name="prioritize_authors" type="array" label="Prioritize Authors" description="Prioritize images by author (comma-separated, in order)" />
            <SingleSetting name="expand_headers" type="text" label="Expand app header size" description="Set custom header height" />
            <SingleSetting name="app_page_button" type="bool" label="Show SG button" description="Show SG button on application pages" />
            <SingleSetting name="collection_button" type="bool" label="Show SGDB button" description="Show SGDB button for Collections" />
            <SingleSetting name="disable_webp" type="bool" label="Disable WEBP support" description="Avoids crashes for some users" />
            <SingleSetting name="reapply_app_page" type="bool" label="Reapply on UI modification" description="Fixes header size problem, causes others" />
            <ImageSearchSetting name="grids_config" label="Grids" />
            <ImageSearchSetting name="wide_grids_config" label="Wide Grids" />
            <ImageSearchSetting name="heroes_config" label="Heroes" />
            <ImageSearchSetting name="logos_config" label="Logos" />
            <ImageSearchSetting name="icons_config" label="Icons" />
            <SingleSetting name="icons_enabled" type="bool" label="Enable Icons" description="Enable functionality for Icons" />
            <SingleSetting name="grids_width_mult" type="num" label="Grid width scale" description="Scale preview images on the GUI" />
            <SingleSetting name="heroes_width_mult" type="num" label="Hero width scale" description="Scale preview images on the GUI" />
            <SingleSetting name="logos_width_mult" type="num" label="Logo width scale" description="Scale preview images on the GUI" />
            <SingleSetting name="icons_width_mult" type="num" label="Icon width scale" description="Scale preview images on the GUI" />
        </div>
    );
};

export default definePlugin(async () => {
    console.log("[steam-easygrid 4] frontend startup");
    const rawValue = localStorage.getItem("luthor112.steam-easygrid.config");
    const storedConfig: Partial<PluginConfig> = rawValue ? JSON.parse(rawValue) : {};
    pluginConfig = { ...pluginConfig, ...storedConfig };
    const rawOverrideValue = localStorage.getItem("luthor112.steam-easygrid.overrides");
    gameIDOverrides = { ...gameIDOverrides, ...(rawOverrideValue ? JSON.parse(rawOverrideValue) : {}) };
    const rawCustomizationValue = localStorage.getItem("luthor112.steam-easygrid.customization");
    customizationStates = { ...customizationStates, ...(rawCustomizationValue ? JSON.parse(rawCustomizationValue) : {}) };
    Millennium.AddWindowCreateHook!(OnPopupCreation);
    return {
        title: "Easy SteamGrid",
        icon: <IconsModule.Settings />,
        content: <SettingsContent />,
    };
});
