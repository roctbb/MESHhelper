export class ModeScreen {
  constructor(refs, { onOpenAnalytics, onOpenMarking, onOpenFinalMarks, onOpenSoftSkills, onOpenMailings }) {
    this.refs = refs;
    this.onOpenAnalytics = onOpenAnalytics;
    this.onOpenMarking = onOpenMarking;
    this.onOpenFinalMarks = onOpenFinalMarks;
    this.onOpenSoftSkills = onOpenSoftSkills;
    this.onOpenMailings = onOpenMailings;
  }

  bind() {
    this.refs.openAnalyticsModeBtn.addEventListener('click', () => this.onOpenAnalytics());
    this.refs.openMarkingModeBtn.addEventListener('click', () => this.onOpenMarking());
    this.refs.openFinalMarksModeBtn.addEventListener('click', () => this.onOpenFinalMarks());
    this.refs.openSoftSkillsModeBtn.addEventListener('click', () => this.onOpenSoftSkills());
    this.refs.openMailingsModeBtn.addEventListener('click', () => this.onOpenMailings());
  }
}
