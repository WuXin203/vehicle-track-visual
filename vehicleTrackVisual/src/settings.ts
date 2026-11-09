"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

class MapCard extends formattingSettings.SimpleCard {
    apiKey = new formattingSettings.TextInput({
        name: "apiKey", displayName: "AMap Web Key", value: "", placeholder: "在高德开放平台创建的 Web 端 Key"
    });
    securityCode = new formattingSettings.TextInput({
        name: "securityCode", displayName: "securityJsCode", value: "", placeholder: "高德安全密钥"
    });
    coordinateSystem = new formattingSettings.ItemDropdown({
        name: "coordinateSystem", displayName: "源坐标系", value: { displayName: "GCJ-02", value: "GCJ02" },
        items: [
            { displayName: "GCJ-02", value: "GCJ02" },
            { displayName: "WGS-84", value: "WGS84" },
            { displayName: "BD-09", value: "BD09" }
        ]
    });
    markerStyle = new formattingSettings.ItemDropdown({
        name: "markerStyle", displayName: "GPS 点形态", value: { displayName: "圆点", value: "circle" },
        items: [
            { displayName: "圆点", value: "circle" },
            { displayName: "定位图钉", value: "pin" }
        ]
    });
    linePalette = new formattingSettings.ItemDropdown({
        name: "linePalette", displayName: "轨迹线色卡", value: { displayName: "鲜明自动色卡", value: "vivid" },
        items: [
            { displayName: "鲜明自动色卡", value: "vivid" },
            { displayName: "柔和自动色卡", value: "soft" },
            { displayName: "色盲友好 8 色", value: "accessible" }
        ]
    });
    pointPalette = new formattingSettings.ItemDropdown({
        name: "pointPalette", displayName: "普通点色卡", value: { displayName: "鲜明自动色卡", value: "vivid" },
        items: [
            { displayName: "鲜明自动色卡", value: "vivid" },
            { displayName: "柔和自动色卡", value: "soft" },
            { displayName: "色盲友好 8 色", value: "accessible" }
        ]
    });
    name = "map";
    displayName = "高德地图配置";
    slices = [this.apiKey, this.securityCode, this.coordinateSystem, this.markerStyle, this.linePalette, this.pointPalette];
}

export class VisualFormattingSettingsModel extends formattingSettings.Model {
    mapCard = new MapCard();
    cards = [this.mapCard];
}
