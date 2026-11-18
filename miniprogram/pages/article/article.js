var D = require("../../utils/data.js");

Page({
  data: { article: null },
  onLoad: function (options) {
    var a = D.ARTICLES.filter(function (x) { return x.id === options.id; })[0] || null;
    this.setData({ article: a });
  }
});