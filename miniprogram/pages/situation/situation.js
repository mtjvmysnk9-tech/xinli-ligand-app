var D = require("../../utils/data.js");

Page({
  data: { sit: null },
  onLoad: function (options) {
    var s = D.SITUATIONS.filter(function (x) { return x.id === options.id; })[0] || null;
    this.setData({ sit: s });
  },
  back: function () { wx.navigateBack(); }
});