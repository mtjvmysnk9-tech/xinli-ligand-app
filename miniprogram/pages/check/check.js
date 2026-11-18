var D = require("../../utils/data.js");

Page({
  data: {
    stage: "intro",
    q: 0,
    total: D.QUESTIONS.length,
    question: "",
    options: D.OPTIONS,
    progress: 0,
    score: 0,
    result: null
  },
  start: function () {
    this.answers = [];
    this.setData({ stage: "quiz", q: 0, question: D.QUESTIONS[0], progress: 100 / D.QUESTIONS.length });
  },
  opt: function (e) {
    var v = Number(e.currentTarget.dataset.v);
    this.answers[this.data.q] = v;
    var next = this.data.q + 1;
    if (next < D.QUESTIONS.length) {
      this.setData({ q: next, question: D.QUESTIONS[next], progress: ((next + 1) / D.QUESTIONS.length) * 100 });
    } else {
      var score = this.answers.reduce(function (a, b) { return a + b; }, 0);
      this.setData({ stage: "result", score: score, result: D.band(score) });
    }
  },
  prevq: function () {
    var prev = this.data.q - 1;
    if (prev < 0) return;
    this.setData({ q: prev, question: D.QUESTIONS[prev], progress: ((prev + 1) / D.QUESTIONS.length) * 100 });
  },
  retake: function () {
    this.answers = [];
    this.setData({ stage: "intro", q: 0, score: 0, result: null });
  },
  goJournal: function () { wx.switchTab({ url: "/pages/journal/journal" }); },
  goScience: function () {
    getApp().globalData.disc = "science";
    wx.switchTab({ url: "/pages/discover/discover" });
  },
  goHelp: function () {
    getApp().globalData.sup = "help";
    wx.switchTab({ url: "/pages/support/support" });
  }
});