import { FLAT_EARTH_ORIGIN, FLAT_EARTH_RADIUS } from '@world/flatEarth';

/**
 * THE WHOLE EARTH ON THE FLAT MAP (`world/flatEarth.ts`): the planet's
 * climates and ice read at the same point of the sphere as the globe draws
 * them, its direction from the plane's longitude and latitude (the
 * equirectangular map: x east, y north, at the planet's radius), so the flat
 * map's poles carry the same ice caps, shelves and crevasses, its belts the
 * same deserts and tundra. In float32 the direction is good to a millimetre
 * over the 25 km of the map.
 */
export const FLAT_EARTH_GLSL = __PLANET__ ? '' : `
  const float PLANET_R = ${FLAT_EARTH_RADIUS.toFixed(6)};
  vec3 planetDirection(vec3 p, out vec3 e, out vec3 n) {
    float lon = ${FLAT_EARTH_ORIGIN.lon.toFixed(9)} + p.x / PLANET_R;
    float lat = clamp(${FLAT_EARTH_ORIGIN.lat.toFixed(9)} - p.z / PLANET_R, -1.5707963, 1.5707963);
    float cl = cos(lat), sl = sin(lat), co = cos(lon), so = sin(lon);
    e = vec3(-so, co, 0.0);
    n = vec3(-sl * co, -sl * so, cl);
    return vec3(cl * co, cl * so, sl);
  }
  // No night side on the plane: the sun lights it as the sky's own light does.
  float planetDaylight(vec3 p, vec3 l) { return 1.0; }
`;

