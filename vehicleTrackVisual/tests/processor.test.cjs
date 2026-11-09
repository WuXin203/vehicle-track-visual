const test = require("node:test");
const assert = require("node:assert/strict");
const { processTrackRows, colorForVin, normalizeAbnormalTag, getTrackEndpoints } = require("../.tmp/processor-tests/dataProcessor.js");
const { toGcj02 } = require("../.tmp/processor-tests/coordinateTransform.js");

test("groups interleaved rows by VIN and sorts each track by timestamp", () => {
    const result = processTrackRows(
        [121.03, 120.02, 121.01, 120.01],
        [31.03, 30.02, 31.01, 30.01],
        ["A", "B", "A", "B"],
        ["2026-11-01T08:03:00Z", "2026-11-01T08:02:00Z", "2026-11-01T08:01:00Z", "2026-11-01T08:01:00Z"]
    );

    assert.equal(result.tracks.length, 2);
    const trackA = result.tracks.find(track => track.vin === "A");
    const trackB = result.tracks.find(track => track.vin === "B");
    assert.deepEqual(trackA.points.map(point => point.longitude), [121.01, 121.03]);
    assert.deepEqual(trackB.points.map(point => point.longitude), [120.01, 120.02]);
    assert.equal(trackA.color, colorForVin("A"));
    assert.equal(trackB.color, colorForVin("B"));
    assert.notEqual(trackA.color, trackB.color);
    assert.deepEqual(getTrackEndpoints(trackA).map(endpoint => endpoint.point.longitude), [121.01, 121.03]);
    assert.deepEqual(getTrackEndpoints(trackB).map(endpoint => endpoint.kind), ["start", "end"]);
});

test("keeps duplicate timestamps in original row order", () => {
    const result = processTrackRows(
        [121.1, 121.2, 121.3],
        [31.1, 31.2, 31.3],
        ["A", "A", "A"],
        ["2026-11-01T08:01:00Z", "2026-11-01T08:01:00Z", "2026-11-01T08:00:00Z"]
    );

    assert.deepEqual(result.tracks[0].points.map(point => point.longitude), [121.3, 121.1, 121.2]);
    assert.deepEqual(result.tracks[0].points.map(point => point.sequence), [1, 2, 3]);
});

test("drops invalid coordinates, VINs, and timestamps with separate counts", () => {
    const result = processTrackRows(
        [181, 121.1, 121.2, 121.3],
        [31, 31.1, 31.2, 31.3],
        ["A", "", "A", "A"],
        ["2026-11-01T08:00:00Z", "2026-11-01T08:00:00Z", "bad-time", null]
    );

    assert.equal(result.tracks.length, 0);
    assert.equal(result.invalidCoordinates, 1);
    assert.equal(result.invalidVin, 1);
    assert.equal(result.invalidTimestamp, 2);
});

test("does not need an AbnormalTag input to build vehicle tracks", () => {
    const result = processTrackRows(
        [121.1, 121.2],
        [31.1, 31.2],
        ["A", "A"],
        [new Date("2026-11-01T08:00:00Z"), new Date("2026-11-01T08:01:00Z")]
    );

    assert.equal(result.tracks[0].points.length, 2);
});

test("normalizes supported abnormal labels and counts blank and unknown tags", () => {
    assert.equal(normalizeAbnormalTag(true, true).state, "abnormal");
    assert.equal(normalizeAbnormalTag(1, true).state, "abnormal");
    assert.equal(normalizeAbnormalTag("异常", true).state, "abnormal");
    assert.equal(normalizeAbnormalTag(false, true).state, "normal");
    assert.equal(normalizeAbnormalTag("0", true).state, "normal");
    assert.equal(normalizeAbnormalTag("正常", true).state, "normal");
    assert.equal(normalizeAbnormalTag(null, true).state, "normal");
    assert.equal(normalizeAbnormalTag("unmapped", true).state, "unknown");

    const result = processTrackRows(
        [121, 121.1, 121.2, 121.3],
        [31, 31.1, 31.2, 31.3],
        ["A", "A", "A", "A"],
        ["2026-11-01T08:00:00Z", "2026-11-01T08:01:00Z", "2026-11-01T08:02:00Z", "2026-11-01T08:03:00Z"],
        ["异常", "", "not-specified", 0]
    );
    assert.equal(result.abnormalCount, 1);
    assert.equal(result.emptyAbnormalCount, 1);
    assert.equal(result.unknownAbnormalCount, 1);
});

test("uses independently selected line and point palettes for every point in each VIN", () => {
    const result = processTrackRows(
        [121.1, 121.2, 121.3],
        [31.1, 31.2, 31.3],
        ["A", "A", "B"],
        ["2026-11-01T08:00:00Z", "2026-11-01T08:01:00Z", "2026-11-01T08:02:00Z"],
        undefined,
        "vivid",
        "soft"
    );

    const trackA = result.tracks.find(track => track.vin === "A");
    const trackB = result.tracks.find(track => track.vin === "B");
    assert.equal(trackA.lineColor, colorForVin("A", "vivid"));
    assert.deepEqual(trackA.points.map(point => point.pointColor), [colorForVin("A", "soft"), colorForVin("A", "soft")]);
    assert.equal(trackB.points[0].pointColor, colorForVin("B", "soft"));
    assert.notEqual(trackA.lineColor, trackA.points[0].pointColor);
});

test("distributes sequential VINs across the categorical palette", () => {
    const vinValues = ["VIN-A", "VIN-B", "VIN-C", "VIN-D", "VIN-E", "VIN-F", "VIN-G", "VIN-H"];
    const colors = new Set(vinValues.map(vin => colorForVin(vin)));
    assert.equal(colors.size, 8);
});

test("marks a single-point vehicle only once as a combined start/end", () => {
    const result = processTrackRows([121.1], [31.1], ["ONLY"], ["2026-11-01T08:00:00Z"]);
    assert.deepEqual(getTrackEndpoints(result.tracks[0]).map(endpoint => endpoint.kind), ["single"]);
});

test("converts WGS-84 and BD-09 into GCJ-02 while leaving overseas WGS-84 unchanged", () => {
    const wgs = toGcj02(116.397, 39.908, "WGS84");
    assert.ok(Math.abs(wgs.longitude - 116.4032433785) < 1e-8);
    assert.ok(Math.abs(wgs.latitude - 39.9094033539) < 1e-8);

    const bd = toGcj02(116.410369, 39.916105, "BD09");
    assert.ok(Math.abs(bd.longitude - 116.4039958308) < 1e-8);
    assert.ok(Math.abs(bd.latitude - 39.9097662034) < 1e-8);

    assert.deepEqual(toGcj02(-73.9857, 40.7484, "WGS84"), { longitude: -73.9857, latitude: 40.7484 });
});

test("stores source coordinates and uses converted coordinates for map geometry", () => {
    const result = processTrackRows([116.397], [39.908], ["A"], ["2026-11-01T08:00:00Z"], undefined, "vivid", "vivid", "WGS84");
    const point = result.tracks[0].points[0];
    assert.equal(point.sourceLongitude, 116.397);
    assert.equal(point.sourceLatitude, 39.908);
    assert.notEqual(point.longitude, point.sourceLongitude);
    assert.equal(point.sourceCoordinateSystem, "WGS84");
});
