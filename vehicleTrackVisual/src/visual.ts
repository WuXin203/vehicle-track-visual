"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import "./../style/visual.less";
import { VisualFormattingSettingsModel } from "./settings";
import { ColorPaletteName, getTrackEndpoints, processTrackRows, VehicleTrack } from "./dataProcessor";
import { SourceCoordinateSystem } from "./coordinateTransform";

import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;

type AMapWindow = Window & { AMap?: any; _AMapSecurityConfig?: { securityJsCode: string } };
const AMAP_SCRIPT = "https://webapi.amap.com/maps?v=2.0";
let amapPromise: Promise<any> | undefined;

function loadAMap(key: string, securityCode: string): Promise<any> {
    const win = window as AMapWindow;
    if (win.AMap) return Promise.resolve(win.AMap);
    if (!amapPromise) {
        win._AMapSecurityConfig = { securityJsCode: securityCode };
        amapPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = `${AMAP_SCRIPT}&key=${encodeURIComponent(key)}`;
            script.async = true;
            script.onload = () => win.AMap ? resolve(win.AMap) : reject(new Error("高德地图脚本已加载，但 AMap 未初始化。"));
            script.onerror = () => reject(new Error("无法加载高德地图。请检查 WebAccess 权限、网络策略和 Key。"));
            document.head.appendChild(script);
        });
    }
    return amapPromise;
}

function getMapConfig(dataView: powerbi.DataView | undefined): { key: string; securityCode: string; coordinateSystem: string; markerStyle: string; linePalette: string; pointPalette: string } {
    const props = dataView?.metadata?.objects?.map as Record<string, unknown> | undefined;
    return {
        key: String(props?.apiKey ?? "").trim(),
        securityCode: String(props?.securityCode ?? "").trim(),
        coordinateSystem: String(props?.coordinateSystem ?? "GCJ02") || "GCJ02",
        markerStyle: String(props?.markerStyle ?? "circle"),
        linePalette: String(props?.linePalette ?? "vivid"),
        pointPalette: String(props?.pointPalette ?? "vivid")
    };
}

export class Visual implements IVisual {
    private readonly host: powerbi.extensibility.visual.IVisualHost;
    private readonly root: HTMLDivElement;
    private readonly status: HTMLDivElement;
    private readonly toolbar: HTMLDivElement;
    private readonly credentialsPanel: HTMLFormElement;
    private readonly legend: HTMLDivElement;
    private readonly vehicleList: HTMLDivElement;
    private readonly mapElement: HTMLDivElement;
    private map: any;
    private readonly overlaysByVin = new Map<string, any[]>();
    private readonly visibilityByVin = new Map<string, boolean>();
    private readonly selectionManager: ISelectionManager;
    private destroyed = false;
    private readonly formattingService = new FormattingSettingsService();
    private formattingSettings = new VisualFormattingSettingsModel();
    private currentDataView?: powerbi.DataView;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.root = document.createElement("div");
        this.root.className = "vehicle-visual";
        this.status = document.createElement("div");
        this.status.className = "vehicle-status";
        this.toolbar = document.createElement("div");
        this.toolbar.className = "vehicle-toolbar";
        this.addToolbarButton("地图凭据", () => this.toggleCredentialsPanel());
        this.addToolbarButton("全部显示", () => this.setAllVehiclesVisible(true));
        this.addToolbarButton("全部隐藏", () => this.setAllVehiclesVisible(false));
        this.addToolbarButton("FitView", () => this.fitVisibleVehicles());
        this.addToolbarButton("清除选择", () => { void this.selectionManager.clear(); });
        this.credentialsPanel = this.createCredentialsPanel();
        this.legend = document.createElement("div");
        this.legend.className = "vehicle-legend";
        const content = document.createElement("div");
        content.className = "vehicle-content";
        this.vehicleList = document.createElement("div");
        this.vehicleList.className = "vehicle-list";
        this.vehicleList.setAttribute("aria-label", "车辆轨迹列表");
        this.mapElement = document.createElement("div");
        this.mapElement.className = "vehicle-map";
        content.append(this.vehicleList, this.mapElement);
        this.root.append(this.status, this.toolbar, this.credentialsPanel, this.legend, content);
        options.element.appendChild(this.root);
    }

    public update(options: VisualUpdateOptions): void {
        this.host.eventService.renderingStarted(options);
        void this.render(options).then(
            () => this.host.eventService.renderingFinished(options),
            (error: unknown) => {
                this.setStatus(error instanceof Error ? error.message : "地图初始化失败。", "error");
                this.host.eventService.renderingFailed(options, String(error));
            }
        );
    }

    private async render(options: VisualUpdateOptions): Promise<void> {
        const dataView = options.dataViews?.[0];
        this.currentDataView = dataView;
        if (dataView) this.formattingSettings = this.formattingService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);
        const config = getMapConfig(dataView);
        const categories = dataView?.categorical?.categories ?? [];
        const byRole = new Map<string, powerbi.DataViewCategoryColumn>();
        categories.forEach(column => Object.keys(column.source.roles ?? {}).forEach(role => byRole.set(role, column)));

        // AbnormalTag is intentionally optional. A regular point/track map
        // must still work for reports that do not classify abnormal points.
        const required = ["longitude", "latitude", "vin", "timestamp"];
        const missing = required.filter(role => !byRole.has(role));
        if (missing.length) {
            this.setStatus(`请将以下字段拖入字段槽：${missing.join("、")}`, "notice");
            this.legend.replaceChildren();
            this.vehicleList.replaceChildren();
            this.clearOverlays();
            return;
        }
        if (!config.key || !config.securityCode) {
            this.setStatus("请点击“地图凭据”输入 AMap Web Key 与 securityJsCode。", "notice");
            return;
        }
        const longitude = byRole.get("longitude")!;
        const latitude = byRole.get("latitude")!;
        const vin = byRole.get("vin")!;
        const timestamp = byRole.get("timestamp")!;
        const abnormal = byRole.get("abnormalTag");
        const processed = processTrackRows(
            longitude.values,
            latitude.values,
            vin.values,
            timestamp.values,
            abnormal?.values,
            config.linePalette as ColorPaletteName,
            config.pointPalette as ColorPaletteName,
            config.coordinateSystem as SourceCoordinateSystem
        );
        const tracks: VehicleTrack[] = processed.tracks;
        const selectionIds = new Map<number, ISelectionId>();
        for (const track of tracks) {
            for (const point of track.points) {
                let builder = this.host.createSelectionIdBuilder();
                for (const category of categories) builder = builder.withCategory(category, point.sourceIndex);
                selectionIds.set(point.sourceIndex, builder.createSelectionId());
            }
        }
        this.renderVehicleList(tracks);
        const validPointCount = tracks.reduce((sum, track) => sum + track.points.length, 0);
        const abnormalStatus = abnormal
            ? ` · ${processed.abnormalCount} 个异常${processed.emptyAbnormalCount ? ` · ${processed.emptyAbnormalCount} 个标签为空` : ""}${processed.unknownAbnormalCount ? ` · ${processed.unknownAbnormalCount} 个标签无法识别` : ""}`
            : " · 未映射 AbnormalTag";
        this.setStatus(
            `${tracks.length} 辆车 · ${validPointCount} 个有效点 · ${config.coordinateSystem || "GCJ02"} → GCJ-02${abnormalStatus}${processed.invalidCoordinates ? ` · ${processed.invalidCoordinates} 个坐标无效` : ""}${processed.invalidVin ? ` · ${processed.invalidVin} 个 VIN 为空` : ""}${processed.invalidTimestamp ? ` · ${processed.invalidTimestamp} 个时间无效` : ""}`,
            processed.unknownAbnormalCount ? "warning" : "notice"
        );
        this.renderLegend(tracks);

        const AMap = await loadAMap(config.key, config.securityCode);
        if (this.destroyed) return;
        if (!this.map) this.map = new AMap.Map(this.mapElement, { zoom: 4, viewMode: "2D" });

        this.clearOverlays();
        // Add all vehicle lines first so GPS point overlays sit above them.
        for (const track of tracks) {
            const vehicleOverlays: any[] = [];
            if (track.points.length < 2) continue;
            const line = new AMap.Polyline({
                path: track.points.map(point => [point.longitude, point.latitude]),
                strokeColor: track.lineColor,
                strokeOpacity: 0.82,
                strokeWeight: 4,
                lineJoin: "round",
                lineCap: "round",
                zIndex: 10
            });
            this.map.add(line);
            vehicleOverlays.push(line);
            this.overlaysByVin.set(track.vin, vehicleOverlays);
        }

        // The sorted first/last point defines each vehicle's start/end. A
        // single-point vehicle receives one combined marker only.
        for (const track of tracks) {
            const vehicleOverlays = this.overlaysByVin.get(track.vin) ?? [];
            for (const endpoint of getTrackEndpoints(track)) {
                const point = endpoint.point;
                const location: [number, number] = [point.longitude, point.latitude];
                const color = endpoint.kind === "end" ? "#173b63" : "#17834a";
                const marker = new AMap.Marker({
                    position: location,
                    content: this.createEndpointContent(endpoint.kind, color),
                    offset: new AMap.Pixel(-14, -30),
                    title: endpoint.kind === "start" ? "起点" : endpoint.kind === "end" ? "终点" : "起终点",
                    zIndex: 26
                });
                this.map.add(marker);
                this.bindPointInteraction(marker, point, selectionIds.get(point.sourceIndex), AMap, location);
                vehicleOverlays.push(marker);
                this.overlaysByVin.set(track.vin, vehicleOverlays);
            }
        }

        for (const track of tracks) {
            const vehicleOverlays = this.overlaysByVin.get(track.vin) ?? [];
            for (const point of track.points) {
                const location: [number, number] = [point.longitude, point.latitude];
                const pointColor = point.abnormalState === "abnormal" ? "#d71920"
                    : point.abnormalState === "unknown" ? "#e89516"
                        : point.pointColor;
                const marker = config.markerStyle === "pin"
                    ? new AMap.Marker({ position: location, content: this.createPinContent(pointColor), offset: new AMap.Pixel(-10, -22), title: point.vin, zIndex: point.abnormalState === "abnormal" ? 30 : 20 })
                    : new AMap.CircleMarker({
                        center: location,
                        radius: point.abnormalState === "abnormal" ? 7 : 5,
                        strokeColor: "#ffffff",
                        strokeWeight: point.abnormalState === "abnormal" ? 3 : 2,
                        fillColor: pointColor,
                        fillOpacity: 0.95,
                        zIndex: point.abnormalState === "abnormal" ? 30 : point.abnormalState === "unknown" ? 25 : 20
                    });
                this.map.add(marker);
                this.bindPointInteraction(marker, point, selectionIds.get(point.sourceIndex), AMap, location);
                vehicleOverlays.push(marker);
            }
            this.overlaysByVin.set(track.vin, vehicleOverlays);
            if (!(this.visibilityByVin.get(track.vin) ?? true)) vehicleOverlays.forEach(overlay => overlay.hide());
        }

        this.fitVisibleVehicles();
        this.map.resize();
    }

    private addToolbarButton(label: string, action: () => void): void {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "vehicle-toolbar-button";
        button.textContent = label;
        button.addEventListener("click", action);
        this.toolbar.appendChild(button);
    }

    private createCredentialsPanel(): HTMLFormElement {
        const panel = document.createElement("form");
        panel.className = "vehicle-credentials hidden";
        panel.setAttribute("aria-label", "地图凭据配置");
        const keyLabel = document.createElement("label");
        keyLabel.textContent = "AMap Web Key";
        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.name = "apiKey";
        keyInput.autocomplete = "new-password";
        keyInput.placeholder = "输入 Web Key";
        keyInput.setAttribute("aria-label", "AMap Web Key");
        const codeLabel = document.createElement("label");
        codeLabel.textContent = "securityJsCode";
        const codeInput = document.createElement("input");
        codeInput.type = "password";
        codeInput.name = "securityCode";
        codeInput.autocomplete = "new-password";
        codeInput.placeholder = "输入安全密钥";
        codeInput.setAttribute("aria-label", "securityJsCode");
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "vehicle-toolbar-button";
        save.textContent = "保存凭据";
        panel.append(keyLabel, keyInput, codeLabel, codeInput, save);
        panel.addEventListener("submit", event => {
            event.preventDefault();
            const current = getMapConfig(this.currentDataView);
            const key = keyInput.value.trim();
            const securityCode = codeInput.value.trim();
            if ((!key && !current.key) || (!securityCode && !current.securityCode)) {
                this.setStatus("请填写尚未配置的 Web Key 和 securityJsCode。", "notice");
                return;
            }
            const properties: Record<string, unknown> = {};
            if (key) properties.apiKey = key;
            if (securityCode) properties.securityCode = securityCode;
            this.host.persistProperties({ merge: [{ objectName: "map", selector: null, properties }] });
            keyInput.value = "";
            codeInput.value = "";
            panel.classList.add("hidden");
            this.setStatus("凭据已保存到报表配置。输入框已清空；报表配置本身不提供加密保管。", "notice");
        });
        return panel;
    }

    private toggleCredentialsPanel(): void {
        const opening = this.credentialsPanel.classList.contains("hidden");
        this.credentialsPanel.classList.toggle("hidden", !opening);
        if (!opening) return;
        const config = getMapConfig(this.currentDataView);
        const keyInput = this.credentialsPanel.elements.namedItem("apiKey") as HTMLInputElement;
        const codeInput = this.credentialsPanel.elements.namedItem("securityCode") as HTMLInputElement;
        keyInput.placeholder = config.key ? "已配置，留空则保持不变" : "输入 Web Key";
        codeInput.placeholder = config.securityCode ? "已配置，留空则保持不变" : "输入安全密钥";
        keyInput.focus();
    }

    private renderVehicleList(tracks: VehicleTrack[]): void {
        this.vehicleList.replaceChildren();
        const heading = document.createElement("div");
        heading.className = "vehicle-list-heading";
        heading.textContent = `车辆 (${tracks.length})`;
        this.vehicleList.appendChild(heading);
        for (const track of tracks) {
            if (!this.visibilityByVin.has(track.vin)) this.visibilityByVin.set(track.vin, true);
            const row = document.createElement("div");
            row.className = "vehicle-list-row";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = this.visibilityByVin.get(track.vin) ?? true;
            checkbox.setAttribute("aria-label", `${track.vin} 显示轨迹`);
            checkbox.addEventListener("change", () => this.setVehicleVisible(track.vin, checkbox.checked));
            const swatch = document.createElement("span");
            swatch.className = "vehicle-list-swatch";
            swatch.style.backgroundColor = track.lineColor;
            const details = document.createElement("div");
            details.className = "vehicle-list-details";
            const locate = document.createElement("button");
            locate.type = "button";
            locate.className = "vehicle-locate-button";
            locate.textContent = track.vin;
            locate.title = `定位到 ${track.vin}`;
            locate.addEventListener("click", () => this.fitVehicle(track.vin));
            const abnormalCount = track.points.filter(point => point.abnormalState === "abnormal").length;
            const stats = document.createElement("small");
            stats.textContent = `${track.points.length} 点 · ${abnormalCount} 异常`;
            details.append(locate, stats);
            row.append(checkbox, swatch, details);
            this.vehicleList.appendChild(row);
        }
    }

    private setVehicleVisible(vin: string, visible: boolean): void {
        this.visibilityByVin.set(vin, visible);
        (this.overlaysByVin.get(vin) ?? []).forEach(overlay => visible ? overlay.show() : overlay.hide());
    }

    private setAllVehiclesVisible(visible: boolean): void {
        const vins = new Set([...this.visibilityByVin.keys(), ...this.overlaysByVin.keys()]);
        for (const vin of vins) this.setVehicleVisible(vin, visible);
        this.vehicleList.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(checkbox => { checkbox.checked = visible; });
    }

    private fitVehicle(vin: string): void {
        this.setVehicleVisible(vin, true);
        this.vehicleList.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(checkbox => {
            if (checkbox.getAttribute("aria-label") === `${vin} 显示轨迹`) checkbox.checked = true;
        });
        const overlays = this.overlaysByVin.get(vin) ?? [];
        if (overlays.length) this.map?.setFitView(overlays, false, [32, 32, 32, 32]);
    }

    private fitVisibleVehicles(): void {
        const visible = Array.from(this.overlaysByVin.entries())
            .filter(([vin]) => this.visibilityByVin.get(vin) ?? true)
            .flatMap(([, overlays]) => overlays);
        if (visible.length) this.map?.setFitView(visible, false, [24, 24, 24, 24]);
    }

    private renderLegend(tracks: VehicleTrack[]): void {
        this.legend.replaceChildren();
        for (const track of tracks) {
            const item = document.createElement("span");
            item.className = "vehicle-legend-item";
            const lineSwatch = document.createElement("span");
            lineSwatch.className = "vehicle-legend-line";
            lineSwatch.style.backgroundColor = track.lineColor;
            const pointSwatch = document.createElement("span");
            pointSwatch.className = "vehicle-legend-swatch";
            pointSwatch.style.backgroundColor = track.points[0]?.pointColor ?? track.color;
            const label = document.createElement("span");
            const abnormalCount = track.points.filter(point => point.abnormalState === "abnormal").length;
            const unknownCount = track.points.filter(point => point.abnormalState === "unknown").length;
            label.textContent = `${track.vin} · ${track.points.length} 点 · ${abnormalCount} 异常${unknownCount ? ` · ${unknownCount} 未识别` : ""}`;
            item.append(lineSwatch, pointSwatch, label);
            this.legend.appendChild(item);
        }
        if (tracks.some(track => track.points.some(point => point.abnormalState === "abnormal"))) {
            this.appendLegendKey("#d71920", "异常点");
        }
        if (tracks.some(track => track.points.some(point => point.abnormalState === "unknown"))) {
            this.appendLegendKey("#e89516", "未知标签");
        }
        if (tracks.length) {
            this.appendLegendKey("#17834a", "起点");
            this.appendLegendKey("#173b63", "终点");
        }
    }

    private appendLegendKey(color: string, labelText: string): void {
        const item = document.createElement("span");
        item.className = "vehicle-legend-item";
        const swatch = document.createElement("span");
        swatch.className = "vehicle-legend-swatch";
        swatch.style.backgroundColor = color;
        const label = document.createElement("span");
        label.textContent = labelText;
        item.append(swatch, label);
        this.legend.appendChild(item);
    }

    private createEndpointContent(kind: "start" | "end" | "single", color: string): HTMLElement {
        const badge = document.createElement("div");
        badge.className = "vehicle-endpoint";
        badge.style.backgroundColor = color;
        badge.textContent = kind === "start" ? "起" : kind === "end" ? "终" : "起终";
        return badge;
    }

    private bindPointInteraction(marker: any, point: VehicleTrack["points"][number], selectionId: ISelectionId | undefined, AMap: any, location: [number, number]): void {
        marker.on("click", (event: any) => {
            if (selectionId && this.host.hostCapabilities.allowInteractions) {
                void this.selectionManager.select(selectionId, Boolean(event?.originalEvent?.ctrlKey));
            }
            const info = new AMap.InfoWindow({ content: this.createInfoContent(point) });
            info.open(this.map, location);
        });
    }

    private createInfoContent(point: VehicleTrack["points"][number]): HTMLElement {
        const content = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = point.vin;
        const coordinate = document.createElement("div");
        coordinate.textContent = `来源坐标 ${point.sourceLongitude.toFixed(6)}, ${point.sourceLatitude.toFixed(6)} (${point.sourceCoordinateSystem})`;
        const mapCoordinate = document.createElement("div");
        mapCoordinate.textContent = point.sourceCoordinateSystem === "GCJ02"
            ? "地图坐标与来源坐标相同"
            : `地图坐标 ${point.longitude.toFixed(6)}, ${point.latitude.toFixed(6)} (GCJ-02)`;
        const time = document.createElement("div");
        time.textContent = `时间 ${new Date(point.timestamp).toISOString()} · 顺序 ${point.sequence}`;
        const abnormal = document.createElement("div");
        abnormal.className = point.abnormalState === "abnormal" ? "vehicle-info-abnormal" : point.abnormalState === "unknown" ? "vehicle-info-unknown" : "";
        abnormal.textContent = point.abnormalState === "abnormal" ? `异常 (${point.abnormalLabel})`
            : point.abnormalState === "unknown" ? `无法识别的标签 (${point.abnormalLabel})`
                : point.abnormalLabel ? `正常 (${point.abnormalLabel})` : "正常 / 未映射";
        content.append(title, coordinate, mapCoordinate, time, abnormal);
        return content;
    }

    private createPinContent(color: string): HTMLElement {
        const pin = document.createElement("div");
        pin.className = "vehicle-pin";
        pin.style.backgroundColor = color;
        const center = document.createElement("span");
        center.className = "vehicle-pin-center";
        pin.appendChild(center);
        return pin;
    }

    private setStatus(message: string, kind: string): void {
        this.status.className = `vehicle-status ${kind}`;
        this.status.textContent = message;
    }

    private clearOverlays(): void {
        const overlays = Array.from(this.overlaysByVin.values()).flat();
        if (overlays.length) this.map?.remove(overlays);
        this.overlaysByVin.clear();
    }

    public destroy(): void {
        this.destroyed = true;
        this.clearOverlays();
        this.map?.destroy();
        this.map = undefined;
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingService.buildFormattingModel(this.formattingSettings);
    }
}
