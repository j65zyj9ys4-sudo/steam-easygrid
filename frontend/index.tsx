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

const log_frontend = callable<[{ msg: string }], void>('log_frontend');
// The one artwork pipeline: backend fetches SteamGridDB's ready-to-use file
// (the "-fakepng.png" variant for WebP assets — identical bytes Steam
// natively animates when the filename says .png — or the file as-is for
// assets that are already PNG/JPG/ICO) and returns its base64 untouched.
// Sentinels: "CHUNKED:<n>:<chars>" (oversized — assembled via
// get_artwork_chunk below), "FAILED:<reason>". Anything else is the base64.
const fetch_artwork = callable<[{ appid: number, imagetype: number, img_url: string }], string>('fetch_artwork');
const get_artwork_chunk = callable<[{ appid: number, chunk: number, imagetype: number, img_url: string }], string>('get_artwork_chunk');
const restore_icon = callable<[{ appid: number }], string>('restore_icon');
const get_config = callable<[], string>('get_config');
const set_config = callable<[{ config_json: string }], string>('set_config');

// Assembles artwork base64 from the backend. Files under the single-return
// ceiling arrive in one IPC call; anything larger is streamed in fixed-size
// chunks and reassembled here — JS strings have no such limit, only the
// per-call Lua→JS bridge does. Every size therefore applies through
// SetCustomArtworkForApp instantly, no restart, no file-copy fallback.
async function fetchArtworkB64(appid: number, imagetype: number, img_url: string): Promise<string | undefined> {
    const result = await fetch_artwork({ appid, imagetype, img_url });
    if (!result || result.includes('FAILED')) {
        await log_frontend({ msg: `fetch_artwork failed: ${result}` });
        return undefined;
    }
    if (result.includes('ICON_APPLIED')) {
        // Icons are applied backend-side straight into librarycache (Steam
        // has no API for real-game icons) — nothing to hand to
        // SetCustomArtworkForApp. Restart Steam to see the change.
        return 'ICON_APPLIED';
    }
    const chunked = result.match(/CHUNKED:(\d+):(\d+)/);
    if (chunked) {
        const nChunks = parseInt(chunked[1]);
        const total = parseInt(chunked[2]);
        await log_frontend({ msg: `fetch_artwork: chunked transfer, ${nChunks} chunks, ${total} chars` });
        let b64 = '';
        for (let i = 0; i < nChunks; i++) {
            const part = await get_artwork_chunk({ appid, chunk: i, imagetype, img_url });
            b64 += (part || '').replace(/[^A-Za-z0-9+/=]/g, '');
        }
        if (b64.length !== total) {
            await log_frontend({ msg: `fetch_artwork: reassembly size mismatch (${b64.length} != ${total})` });
            return undefined;
        }
        return b64 || undefined;
    }
    return result.replace(/[^A-Za-z0-9+/=]/g, '') || undefined;
}
const purge_game_cache = callable<[{ appid: number, imagetype: number }], string>('purge_game_cache');
const purge_all_cache = callable<[], string>('purge_all_cache');

let libraryObserver: MutationObserver | null = null; // single observer, replaced on navigation

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
    prioritize_animated: true,
    prioritize_authors: [],
    expand_headers: "",
    app_page_button: true,
    collection_button: true,
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
    const dimStr = ("dimensions" in usedConfig && usedConfig["dimensions"]) ? `&dimensions=${usedConfig.dimensions}` : "";
    const baseQ = `nsfw=${usedConfig.nsfw}&humor=${usedConfig.humor}&epilepsy=${usedConfig.epilepsy}&mimes=${mimeList}&styles=${usedConfig.styles}${dimStr}`;
    const tryTypes = async (types: string): Promise<boolean> => {
        for (let page = 0; ; page++) {
            const result = await callAPI(`${imgSearchTypeName}/game/${gameId}?${baseQ}&types=${types}&page=${page}`);
            if (!result?.data?.length) return false;
            for (const item of result.data) {
                const b64 = await fetchArtworkB64(appId, imgType, item.url);
                if (b64 === 'ICON_APPLIED') { SetCustomizationState(appId, imgType, true); return true; }
                if (b64) { SteamClient.Apps.SetCustomArtworkForApp(appId, b64, getImageExtFromUrl(item.url), imgType); SetCustomizationState(appId, imgType, true); return true; }
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
        // One path for everything, animated and static alike, any size: the
        // backend fetches SGDB's ready-to-use file (fakepng variant for WebP
        // assets) and its untouched base64 is assembled here (chunked when
        // large). Handing those full bytes to SetCustomArtworkForApp is
        // exactly what Steam's own "Set custom artwork" dialog does — the
        // flow proven to animate natively.
        const b64 = await fetchArtworkB64(appId, imgType, imgURL);
        if (b64) await log_frontend({ msg: `fetch_artwork: assembled ${b64.length} chars` });
        return b64;
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
        const [kofiHtml, setKofiHtml] = useState<string>("");

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

            // One unified apply flow, all image types, animated and static:
            // fetch SGDB's ready-to-use file, hand Steam the full untouched
            // bytes — the exact equivalent of the "Set custom artwork" dialog.
            const newImage = await getImageData(props.appid, props.imagetype, targetNum);
            if (newImage === 'ICON_APPLIED') {
                SetCustomizationState(props.appid, props.imagetype, true);
                statusEl.innerText = "DONE✓ (restart Steam)";
                statusEl.style.color = 'darkgreen';
            } else if (newImage) {
                const imageExt = await getImageExt(props.appid, props.imagetype, targetNum);
                SteamClient.Apps.SetCustomArtworkForApp(props.appid, newImage, imageExt!, props.imagetype);
                SetCustomizationState(props.appid, props.imagetype, true);

                if (props.imagetype === 2) {
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
                }

                statusEl.innerText = "DONE✓";
                statusEl.style.color = 'darkgreen';
            } else {
                statusEl.innerText = "FAILED";
                statusEl.style.color = 'darkred';
            }
        };

        const SetOriginalImage = async () => {
            console.log("[steam-easygrid 4] Resetting image...");
            if (props.imagetype === 4) {
                // Icons live in librarycache, not custom artwork — restore
                // Steam's original bytes from the backend's backup sidecar.
                await restore_icon({ appid: props.appid });
            } else {
                SteamClient.Apps.ClearCustomArtworkForApp(props.appid, props.imagetype);
            }
            SetCustomizationState(props.appid, props.imagetype, false);
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

        // Ko-fi support button. Uses the real widget's own init()+getHTML() — deliberately
        // NOT draw(), which document.writeln()s the markup and is only safe during a
        // page's initial synchronous parse. Called well after mount like this, that can
        // blank/rewrite the whole document. getHTML() just returns the same markup as a
        // string, which we render ourselves, in place, like anything else in this row.
        useEffect(() => {
            const kofiWin = popup.m_popup.window as any;
            const buildKofiHtml = () => {
                kofiWin.kofiwidget2.init('Support me on Ko-fi', '#3d4450', 'Y8Y019SFZ6');
                setKofiHtml(kofiWin.kofiwidget2.getHTML());
            };
            if (kofiWin.kofiwidget2) {
                buildKofiHtml();
            } else {
                const kofiScript = popup.m_popup.document.createElement("script");
                kofiScript.src = "https://storage.ko-fi.com/cdn/widget/Widget_2.js";
                kofiScript.onload = buildKofiHtml;
                popup.m_popup.document.body.appendChild(kofiScript);
            }
        }, []);

        return (
            <div>
                App ID: {props.appid} / SGDB ID: {steamGridDBId} / Image Type: {props.imagetype} (found {thumbnailList.length}) <br/>
                <DialogButton style={{width: "90px",  display: "inline-block"}} onClick={SetOriginalImage}>Reset</DialogButton> &nbsp;
                <DialogButton style={{width: "110px", display: "inline-block"}} onClick={PurgeImageCache}>Clear Cache</DialogButton> &nbsp;
                <DialogButton style={{width: "125px", display: "inline-block"}} onClick={OpenWebpage}>Open Webpage</DialogButton> &nbsp;
                <DialogButton style={{width: "100px", display: "inline-block"}} onClick={ResetAllImages}>Reset All</DialogButton> &nbsp;
                <DialogButton style={{width: "130px", display: "inline-block"}} onClick={PurgeAllDiskCache}>Purge All Cache</DialogButton>
                <div style={{display: "inline-block", marginLeft: "8px", marginRight: "8px", verticalAlign: "middle"}}>
                    <TextField style={{width: "91px", boxSizing: "border-box"}} value={sgdbIdInput} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSteamGridDBIdInput(e.currentTarget.value)} mustBeNumeric={true} />
                </div> &nbsp;
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
                <div style={{position: "fixed", left: "20px", bottom: "20px", zIndex: 999}} dangerouslySetInnerHTML={{__html: kofiHtml}} />
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
        libraryObserver = new MutationObserver(async () => {
            await renderApp(popup);
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
    const saveConfig = () => {
        const json = JSON.stringify(pluginConfig);
        localStorage.setItem("luthor112.steam-easygrid.config", json);
        // Write-through to config.json: survives Steam wiping CEF localStorage
        set_config({ config_json: json }).catch(() => {});
        searchCache = {};
    };
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
    // Parse helper: tolerates Millennium's IPC string-wrapping and corrupt
    // values (a half-wiped localStorage entry must not crash the plugin).
    const safeParse = (raw: string | null): any => {
        if (!raw) return {};
        try {
            let v: any = JSON.parse(raw);
            if (typeof v === 'string') v = JSON.parse(v);
            return (v && typeof v === 'object') ? v : {};
        } catch { return {}; }
    };
    const storedConfig: Partial<PluginConfig> = safeParse(localStorage.getItem("luthor112.steam-easygrid.config"));
    pluginConfig = { ...pluginConfig, ...storedConfig };
    // Hydrate from config.json — the durable copy. Steam clears its CEF
    // localStorage on client updates / "delete web browser data"; when that
    // happens, storedConfig is empty and the file restores everything
    // (API key included). Precedence: defaults < file < localStorage, then
    // both stores are converged so they can never drift apart.
    get_config().then((raw) => {
        const fileConfig: Partial<PluginConfig> = safeParse(raw);
        pluginConfig = { ...pluginConfig, ...fileConfig, ...storedConfig };
        const json = JSON.stringify(pluginConfig);
        localStorage.setItem("luthor112.steam-easygrid.config", json);
        set_config({ config_json: json }).catch(() => {});
    }).catch(() => {});
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
