export class ModeScreen {
  constructor(refs, { onOpenAnalytics, onOpenMarking }) {
    this.refs = refs;
    this.onOpenAnalytics = onOpenAnalytics;
    this.onOpenMarking = onOpenMarking;
  }

  bind() {
    this.refs.openAnalyticsModeBtn.addEventListener('click', () => this.onOpenAnalytics());
    this.refs.openMarkingModeBtn.addEventListener('click', () => this.onOpenMarking());
  }
}
