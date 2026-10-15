import characterLicense from '../../public/models/citizens/LICENSE-MICROSOFT.txt?raw';
import animationLicense from '../../public/models/citizens/LICENSE-ANIMATIONS.txt?raw';

/** The Rocketbox models are gone: the street's people are MakeHuman bodies */
export const CITIZEN_ASSET_URLS: Readonly<Record<string, string>> = {};

/** License notices remain in the shipped bundle and in scene metadata. */
export const CITIZEN_LICENSES = { characters: characterLicense, animations: animationLicense };
