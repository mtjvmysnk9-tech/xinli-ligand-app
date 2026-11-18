var D = require("../../utils/data.js");
var KEY = "xl-entries-v1";

function loadEntries() {
  try {
    var v = wx.getStorageSync(KEY);
    return Array.isArray(v) && v.length ? v : D.SEED;
  } catch (e) { return D.SEED; }
}
function decorate(entries) {
  return entries.map(function (e) {
    var m = D.MOODS[e.mood] || D.MOODS[2];
    return Object.assign({}, e, { moodLabel: m.label, moodColor: m.color });
  });
}

Page({
  data: {
    moods: D.MOODS,
    mood: 2,
    worry: 5,
    confidence: 5,
    note: "",
    entries: [],
    saved: false
  },
  onShow: function () {
    var g = getApp().globalData;
    var patch = { entries: decorate(loadEntries()) };
    if (g.mood !== null && g.mood !== undefined) {
      patch.mood = g.mood;
      g.mood = null;
    }
    this.setData(patch);
    if (this._chart) this.drawTrend();
  },
  onReady: function () {
    var that = this;
    wx.createSelectorQuery().in(this).select("#trend").fields({ node: true, size: true }).exec(function (res) {
      if (!res || !res[0] || !res[0].node) return;
      var node = res[0].node, width = res[0].width, height = res[0].height;
      var dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2;
      node.width = width * dpr;
      node.height = height * dpr;
      var ctx = node.getContext("2d");
      ctx.scale(dpr, dpr);
      that._chart = { ctx: ctx, width: width, height: height };
      that.drawTrend();
    });
  },
  drawTrend: function () {
    var c = this._chart;
    if (!c) return;
    var ctx = c.ctx, W = c.width, H = c.height;
    var data = this.data.entries.slice(0, 7).reverse();
    if (!data.length) return;
    var n = data.length;
    function x(i) { return 30 + i * (W - 44) / Math.max(n - 1, 1); }
    function y(v) { return (H - 26) - v * (H - 40) / 10; }
    ctx.clearRect(0, 0, W, H);
    ctx.font = "9px sans-serif";
    [0, 5, 10].forEach(function (v) {
      ctx.strokeStyle = "#E5E1D8";
      ctx.lineWidth = 1;
      ctx.setLineDash(v ? [3, 4] : []);
      ctx.beginPath(); ctx.moveTo(26, y(v)); ctx.lineTo(W - 8, y(v)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#8A9BA3";
      ctx.textAlign = "right";
      ctx.fillText(String(v), 20, y(v) + 3);
    });
    [["worry", "#E9A23B"], ["confidence", "#3BA55D"]].forEach(function (pair) {
      var k = pair[0], color = pair[1];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      data.forEach(function (e, i) {
        if (i === 0) ctx.moveTo(x(i), y(e[k])); else ctx.lineTo(x(i), y(e[k]));
      });
      ctx.stroke();
      ctx.fillStyle = color;
      data.forEach(function (e, i) {
        ctx.beginPath(); ctx.arc(x(i), y(e[k]), 2.6, 0, Math.PI * 2); ctx.fill();
      });
    });
    ctx.fillStyle = "#8A9BA3";
    ctx.textAlign = "center";
    data.forEach(function (e, i) { ctx.fillText(e.date, x(i), H - 8); });
  },
  onMood: function (e) {
    this.setData({ mood: Number(e.currentTarget.dataset.i), saved: false });
  },
  onWorry: function (e) { this.setData({ worry: e.detail.value, saved: false }); },
  onConfidence: function (e) { this.setData({ confidence: e.detail.value, saved: false }); },
  onNote: function (e) { this.setData({ note: e.detail.value, saved: false }); },
  save: function () {
    var d = new Date();
    var entry = {
      id: Date.now(),
      date: (d.getMonth() + 1) + "/" + d.getDate(),
      mood: this.data.mood,
      worry: this.data.worry,
      confidence: this.data.confidence,
      note: this.data.note
    };
    var raw = loadEntries().slice();
    raw.unshift(entry);
    wx.setStorageSync(KEY, raw);
    this.setData({ entries: decorate(raw), note: "", saved: true });
    this.drawTrend();
    wx.showToast({ title: "已保存", icon: "success" });
  },
  del: function (e) {
    var id = Number(e.currentTarget.dataset.id);
    var raw = loadEntries().filter(function (x) { return x.id !== id; });
    wx.setStorageSync(KEY, raw);
    this.setData({ entries: decorate(raw) });
    this.drawTrend();
  }
});