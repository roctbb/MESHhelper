export class ModeScreen {
  constructor(refs, { onOpenAnalytics, onOpenMarking, onOpenFinalMarks }) {
    this.refs = refs;
    this.onOpenAnalytics = onOpenAnalytics;
    this.onOpenMarking = onOpenMarking;
    this.onOpenFinalMarks = onOpenFinalMarks;
  }

  bind() {
    this.refs.openAnalyticsModeBtn.addEventListener('click', () => this.onOpenAnalytics());
    this.refs.openMarkingModeBtn.addEventListener('click', () => this.onOpenMarking());
    this.refs.openFinalMarksModeBtn.addEventListener('click', () => this.onOpenFinalMarks());
  }
}
