import { SourceCoordinateSystem, toGcj02 } from "./coordinateTransform";

export type TrackPoint = {
    longitude: number;
    latitude: number;
    sourceLongitude: number;
    sourceLatitude: number;
    sourceCoordinateSystem: SourceCoordinateSystem;
    vin: string;
    timestamp: number;
    sourceIndex: number;
    sequence: number;
    color: string;
    pointColor: string;
    abnormalState: "normal" | "abnormal" | "unknown";
    abnormalLabel: string;
};

export type VehicleTrack = { vin: string; color: string; lineColor: string; points: TrackPoint[] };
export type TrackEndpoint = { point: TrackPoint; kind: "start" | "end" | "single" };

export function getTrackEndpoints(track: VehicleTrack): TrackEndpoint[] {
    if (track.points.length === 0) return [];
    if (track.points.length === 1) return [{ point: track.points[0], kind: "single" }];
    return [
        { point: track.points[0], kind: "start" },
        { point: track.points[track.points.length - 1], kind: "end" }
    ];
}

export type TrackProcessingResult = {
    tracks: VehicleTrack[];
    invalidCoordinates: number;
    invalidVin: number;
    invalidTimestamp: number;
    abnormalCount: number;
    emptyAbnormalCount: number;
    unknownAbnormalCount: number;
};

export type ColorPaletteName = "vivid" | "soft" | "accessible";

const accessiblePalette = ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#333333"];

function stableHash(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    // Avalanche the FNV result so sequential VIN suffixes do not cluster into
    // just a couple of neighboring color families.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

export function colorForVin(vin: string, paletteName: ColorPaletteName = "vivid"): string {
    const hash = stableHash(vin);
    if (paletteName === "accessible") return accessiblePalette[hash % accessiblePalette.length];

    // Generate a large, stable swatch space instead of cycling a short list.
    // Hash avalanche spreads VINs across hue, saturation, and lightness bands.
    const hue = hash % 360;
    const vivid = paletteName !== "soft";
    const saturations = vivid ? [76, 88, 96] : [48, 60, 72];
    const lightnesses = vivid ? [40, 49, 58] : [54, 63, 70];
    const saturation = saturations[(hash >>> 9) % saturations.length];
    const lightness = lightnesses[(hash >>> 13) % lightnesses.length];
    return hslToHex(hue, saturation, lightness);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
    const chroma = (1 - Math.abs(2 * lightness / 100 - 1)) * saturation / 100;
    const hueSection = hue / 60;
    const x = chroma * (1 - Math.abs(hueSection % 2 - 1));
    const [red, green, blue] = hueSection < 1 ? [chroma, x, 0]
        : hueSection < 2 ? [x, chroma, 0]
            : hueSection < 3 ? [0, chroma, x]
                : hueSection < 4 ? [0, x, chroma]
                    : hueSection < 5 ? [x, 0, chroma] : [chroma, 0, x];
    const match = lightness / 100 - chroma / 2;
    return `#${[red, green, blue].map(value => Math.round((value + match) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function normalizeAbnormalTag(value: unknown, isMapped: boolean): { state: TrackPoint["abnormalState"]; label: string } {
    if (!isMapped || value === null || value === undefined || (typeof value === "string" && !value.trim())) {
        return { state: "normal", label: "" };
    }
    if (value === true || value === 1) return { state: "abnormal", label: String(value) };
    if (value === false || value === 0) return { state: "normal", label: String(value) };
    if (typeof value === "string") {
        const normalized = value.trim().toLocaleLowerCase();
        if (["true", "1", "异常"].includes(normalized)) return { state: "abnormal", label: value.trim() };
        if (["false", "0", "正常"].includes(normalized)) return { state: "normal", label: value.trim() };
        return { state: "unknown", label: value.trim() };
    }
    return { state: "unknown", label: String(value) };
}

export function timestampValue(value: unknown): number | undefined {
    if (value instanceof Date) {
        const epoch = value.getTime();
        return Number.isFinite(epoch) ? epoch : undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        const epoch = new Date(value).getTime();
        return Number.isFinite(epoch) ? epoch : undefined;
    }
    if (typeof value === "string" && value.trim()) {
        const epoch = Date.parse(value);
        return Number.isFinite(epoch) ? epoch : undefined;
    }
    return undefined;
}

/** Normalize, validate, group, and stably sort aligned DataView category arrays. */
export function processTrackRows(
    longitudes: unknown[],
    latitudes: unknown[],
    vins: unknown[],
    timestamps: unknown[],
    abnormalTags?: unknown[],
    linePalette: ColorPaletteName = "vivid",
    pointPalette: ColorPaletteName = "vivid",
    sourceCoordinateSystem: SourceCoordinateSystem = "GCJ02"
): TrackProcessingResult {
    const count = Math.min(longitudes.length, latitudes.length, vins.length, timestamps.length, abnormalTags?.length ?? Number.POSITIVE_INFINITY);
    const grouped = new Map<string, TrackPoint[]>();
    let invalidCoordinates = 0;
    let invalidVin = 0;
    let invalidTimestamp = 0;
    let abnormalCount = 0;
    let emptyAbnormalCount = 0;
    let unknownAbnormalCount = 0;

    for (let sourceIndex = 0; sourceIndex < count; sourceIndex++) {
        const rawLon = longitudes[sourceIndex];
        const rawLat = latitudes[sourceIndex];
        const longitude = rawLon === null || rawLon === undefined || rawLon === "" ? Number.NaN : Number(rawLon);
        const latitude = rawLat === null || rawLat === undefined || rawLat === "" ? Number.NaN : Number(rawLat);
        if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
            invalidCoordinates++;
            continue;
        }

        const rawVin = vins[sourceIndex];
        const vin = rawVin === null || rawVin === undefined ? "" : String(rawVin).trim();
        if (!vin) {
            invalidVin++;
            continue;
        }

        const timestamp = timestampValue(timestamps[sourceIndex]);
        if (timestamp === undefined) {
            invalidTimestamp++;
            continue;
        }

        const abnormal = normalizeAbnormalTag(abnormalTags?.[sourceIndex], abnormalTags !== undefined);
        const rawAbnormalTag = abnormalTags?.[sourceIndex];
        if (abnormal.state === "abnormal") abnormalCount++;
        else if (abnormal.state === "unknown") unknownAbnormalCount++;
        else if (abnormalTags !== undefined && (rawAbnormalTag === null || rawAbnormalTag === undefined || (typeof rawAbnormalTag === "string" && !rawAbnormalTag.trim()))) emptyAbnormalCount++;

        const points = grouped.get(vin) ?? [];
        const color = colorForVin(vin, linePalette);
        const pointColor = colorForVin(vin, pointPalette);
        const converted = toGcj02(longitude, latitude, sourceCoordinateSystem);
        points.push({
            longitude: converted.longitude,
            latitude: converted.latitude,
            sourceLongitude: longitude,
            sourceLatitude: latitude,
            sourceCoordinateSystem,
            vin,
            timestamp,
            sourceIndex,
            sequence: 0,
            color,
            pointColor,
            abnormalState: abnormal.state,
            abnormalLabel: abnormal.label
        });
        grouped.set(vin, points);
    }

    const tracks = Array.from(grouped.entries()).map(([vin, points]) => {
        // Keep equal timestamps in source order; duplicate-time records are not dropped.
        points.sort((left, right) => left.timestamp - right.timestamp || left.sourceIndex - right.sourceIndex);
        points.forEach((point, index) => { point.sequence = index + 1; });
        const color = colorForVin(vin, linePalette);
        return { vin, color, lineColor: color, points };
    });

    return { tracks, invalidCoordinates, invalidVin, invalidTimestamp, abnormalCount, emptyAbnormalCount, unknownAbnormalCount };
}
