export type SourceCoordinateSystem = "GCJ02" | "WGS84" | "BD09";

export type Coordinates = { longitude: number; latitude: number };

const PI = Math.PI;
const AXIS = 6378245.0;
const ECCENTRICITY = 0.00669342162296594323;

function outsideChina(longitude: number, latitude: number): boolean {
    return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
}

function transformLatitude(x: number, y: number): number {
    let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
    value += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
    value += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
    return value;
}

function transformLongitude(x: number, y: number): number {
    let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
    value += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
    value += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
    return value;
}

function wgs84ToGcj02(longitude: number, latitude: number): Coordinates {
    if (outsideChina(longitude, latitude)) return { longitude, latitude };
    let deltaLatitude = transformLatitude(longitude - 105, latitude - 35);
    let deltaLongitude = transformLongitude(longitude - 105, latitude - 35);
    const radians = latitude / 180 * PI;
    const magic = Math.sin(radians);
    const magicSquared = 1 - ECCENTRICITY * magic * magic;
    const rootMagic = Math.sqrt(magicSquared);
    deltaLatitude = deltaLatitude * 180 / ((AXIS * (1 - ECCENTRICITY)) / (magicSquared * rootMagic) * PI);
    deltaLongitude = deltaLongitude * 180 / (AXIS / rootMagic * Math.cos(radians) * PI);
    return { longitude: longitude + deltaLongitude, latitude: latitude + deltaLatitude };
}

function bd09ToGcj02(longitude: number, latitude: number): Coordinates {
    const x = longitude - 0.0065;
    const y = latitude - 0.006;
    const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * PI * 3000 / 180);
    const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * PI * 3000 / 180);
    return { longitude: z * Math.cos(theta), latitude: z * Math.sin(theta) };
}

/** Convert the configured source coordinate system to AMap's GCJ-02 once. */
export function toGcj02(longitude: number, latitude: number, source: SourceCoordinateSystem = "GCJ02"): Coordinates {
    if (source === "WGS84") return wgs84ToGcj02(longitude, latitude);
    if (source === "BD09") return bd09ToGcj02(longitude, latitude);
    return { longitude, latitude };
}
