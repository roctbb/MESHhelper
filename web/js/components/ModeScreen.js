export class ModeScreen {
  constructor(refs, { onOpenAnalytics, onOpenMarking, onOpenFinalMarks, onOpenSoftSkills }) {
    this.refs = refs;
    this.onOpenAnalytics = onOpenAnalytics;
    this.onOpenMarking = onOpenMarking;
    this.onOpenFinalMarks = onOpenFinalMarks;
    this.onOpenSoftSkills = onOpenSoftSkills;
  }

  bind() {
    this.refs.openAnalyticsModeBtn.addEventListener('click', () => this.onOpenAnalytics());
    this.refs.openMarkingModeBtn.addEventListener('click', () => this.onOpenMarking());
    this.refs.openFinalMarksModeBtn.addEventListener('click', () => this.onOpenFinalMarks());
    this.refs.openSoftSkillsModeBtn.addEventListener('click', () => this.onOpenSoftSkills());
  }
}
