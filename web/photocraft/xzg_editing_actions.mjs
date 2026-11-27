// The pinned editor handles these commands through its normal shortcut dispatcher.
export const EDITING_ACTIONS = [
    { id: "crop", label: ["裁剪", "Crop"], command: "tools.select.crop", key: "C" },
    { id: "repair", label: ["点修复", "Spot repair"], command: "tools.select.spotHealing", key: "J" },
    { id: "clone", label: ["仿制图章", "Clone stamp"], command: "tools.select.cloneStamp", key: "S" },
    { id: "hand", label: ["平移", "Pan"], command: "tools.select.hand", key: "H" },
    { id: "zoom", label: ["缩放", "Zoom"], command: "tools.select.zoom", key: "Z" },
    { id: "undo", label: ["撤销", "Undo"], command: "edit.undo", key: "F9" },
    { id: "redo", label: ["重做", "Redo"], command: "edit.redo", key: "F10" },
];
