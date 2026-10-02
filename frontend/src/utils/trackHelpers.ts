/**
 * Utility for resolving track-related assets
 */

/**
 * Returns the path to the national flag image for a given country name.
 * The country name is provided by the backend metadata.
 */
export const getCountryFlagPath = (country?: string): string => {
  if (!country) return '';
  // The user has organized flags in /country_flag/ with "Country Name.png" format
  return `/country_flag/${country}.png`;
};

/**
 * Resolves country name from track name / share title / filename.
 */
export const getCountryFromTrackName = (trackName?: string): string => {
  if (!trackName) return '';
  const clean = trackName.toLowerCase();
  if (clean.includes('bahrain') || clean.includes('sakhir')) return 'Bahrain';
  if (clean.includes('spa') || clean.includes('francorchamps')) return 'Belgium';
  if (clean.includes('interlagos') || clean.includes('pace')) return 'Brazil';
  if (clean.includes('lemans') || clean.includes('le mans') || clean.includes('sarthe') || clean.includes('ricard')) return 'France';
  if (clean.includes('monza') || clean.includes('imola')) return 'Italy';
  if (clean.includes('fuji')) return 'Japan';
  if (clean.includes('portimao') || clean.includes('algarve')) return 'Portugal';
  if (clean.includes('qatar') || clean.includes('losail') || clean.includes('lusail')) return 'Qatar';
  if (clean.includes('aragon') || clean.includes('barcelona') || clean.includes('jerez')) return 'Spain';
  if (clean.includes('silverstone')) return 'United Kingdom';
  if (clean.includes('sebring') || clean.includes('daytona') || clean.includes('laguna') || clean.includes('cota') || clean.includes('indianapolis') || clean.includes('long beach') || clean.includes('road atlanta') || clean.includes('atlanta')) return 'United States';
  return '';
};

/**
 * Resolves a canonical unique track ID for robust track matching.
 */
export const getCanonicalTrackId = (rawName?: string): string => {
  if (!rawName) return '';
  const clean = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. Interlagos / Autódromo José Carlos Pace (Check first to avoid "pace" matching "spa"!)
  if (clean.includes('interlagos') || clean.includes('josecarlo') || clean.includes('autodromojose') || clean.includes('carlospace') || clean.includes('pace')) {
    return 'interlagos';
  }

  // 2. Circuit de Spa-Francorchamps
  if (clean.includes('spa') || clean.includes('francorchamps')) {
    return 'spa';
  }

  // 3. Circuit de la Sarthe / Le Mans
  if (clean.includes('sarthe') || clean.includes('lemans')) {
    return 'lemans';
  }

  // 4. Paul Ricard
  if (clean.includes('ricard') || clean.includes('castellet')) {
    return 'paulricard';
  }

  // 5. COTA
  if (clean.includes('cota') || clean.includes('circuitoftheamericas') || clean.includes('austin')) {
    return 'cota';
  }

  // 6. Fuji Speedway
  if (clean.includes('fuji')) {
    return 'fuji';
  }

  // 7. Imola (Autodromo Enzo e Dino Ferrari)
  if (clean.includes('imola') || clean.includes('enzodino')) {
    return 'imola';
  }

  // 8. Lusail / Qatar
  if (clean.includes('lusail') || clean.includes('losail') || clean.includes('qatar')) {
    return 'lusail';
  }

  // 9. Monza
  if (clean.includes('monza')) {
    return 'monza';
  }

  // 10. Portimao / Algarve
  if (clean.includes('portimao') || clean.includes('algarve')) {
    return 'portimao';
  }

  // 11. Sebring
  if (clean.includes('sebring')) {
    return 'sebring';
  }

  // 12. Silverstone
  if (clean.includes('silverstone')) {
    return 'silverstone';
  }

  // 13. Barcelona / Catalunya
  if (clean.includes('barcelona') || clean.includes('catalunya')) {
    return 'barcelona';
  }

  // 14. Laguna Seca
  if (clean.includes('laguna') || clean.includes('weathertech')) {
    return 'lagunaseca';
  }

  // 15. Daytona
  if (clean.includes('daytona')) {
    return 'daytona';
  }

  // 16. Bahrain / Sakhir
  if (clean.includes('bahrain') || clean.includes('sakhir')) {
    return 'bahrain';
  }

  // 17. Long Beach
  if (clean.includes('longbeach')) {
    return 'longbeach';
  }

  // 18. Road Atlanta
  if (clean.includes('roadatlanta') || clean.includes('atlanta')) {
    return 'roadatlanta';
  }

  return clean;
};

/**
 * Resolves a normalized car class ID (gt3, hypercar, lmp2, lmp3, gte).
 */
export const getCanonicalCarClass = (carClassStr?: string): string => {
  if (!carClassStr) return '';
  const s = carClassStr.toLowerCase();
  if (s.includes('gt3') || s.includes('lmgt3')) return 'gt3';
  if (s.includes('hyper') || s.includes('lmh') || s.includes('lmdh')) return 'hypercar';
  if (s.includes('lmp2')) return 'lmp2';
  if (s.includes('lmp3')) return 'lmp3';
  if (s.includes('gte')) return 'gte';
  return s;
};

/**
 * Verifies if two tracks have compatible layouts.
 */
export const isLayoutCompatible = (currentTrackName: string, currentLayout: string, shareTitle: string): boolean => {
  const cleanStr = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const combinedCurrent = cleanStr(`${currentTrackName} ${currentLayout}`);
  const cleanShare = cleanStr(shareTitle);

  const distinctKeywords = [
    'mulsanne',    // Le Mans (No chicanes)
    'endurance',   // Bahrain Endurance / Spa Endurance
    'outer',       // Bahrain Outer
    'paddock',     // Bahrain Paddock
    'national',    // COTA National / Silverstone National
    'school',      // Sebring School
    'classic',     // Fuji Classic
    'short',       // Paul Ricard Short / Lusail Short
    'curvagrade',  // Monza Curva Grande
    'elms',        // Paul Ricard ELMS
    '1a',          // Paul Ricard 1A
    '3a'           // Paul Ricard 3A
  ];

  for (const kw of distinctKeywords) {
    const curHas = combinedCurrent.includes(kw);
    const shareHas = cleanShare.includes(kw);
    if (curHas !== shareHas) {
      return false;
    }
  }

  return true;
};

/**
 * Verifies if two car classes are compatible.
 */
export const isCarClassCompatible = (currentCarClass: string, shareTitle: string, shareCarClass?: string): boolean => {
  const curClass = getCanonicalCarClass(currentCarClass);
  if (!curClass) return true;

  const shareClass = getCanonicalCarClass(`${shareTitle} ${shareCarClass || ''}`);
  if (!shareClass) return true;

  return curClass === shareClass;
};

/**
 * Full compatibility checker for reference lap browser (Track + Layout + Car Class).
 */
export const isShareCompatible = (
  currentTrackName: string,
  currentTrackLayout: string,
  currentCarClass: string,
  shareTitle: string,
  shareCarClass?: string
): boolean => {
  // 1. Check Track Match
  const curTrackId = getCanonicalTrackId(currentTrackName);
  const shareTrackId = getCanonicalTrackId(shareTitle);
  if (curTrackId && shareTrackId && curTrackId !== shareTrackId) {
    return false;
  }

  // 2. Check Layout Match
  if (!isLayoutCompatible(currentTrackName, currentTrackLayout || '', shareTitle)) {
    return false;
  }

  // 3. Check Car Class Match
  if (!isCarClassCompatible(currentCarClass, shareTitle, shareCarClass)) {
    return false;
  }

  return true;
};


