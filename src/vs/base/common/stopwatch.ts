

const hasPerformanceNow = true
export class StopWatch {
  private readonly _highResolution: boolean
  private _startTime: number
  private _stopTime: number

  public static create(highResolution: boolean = true): StopWatch {
    return new StopWatch(highResolution)
  }

  constructor(highResolution: boolean = true) {
    this._highResolution = hasPerformanceNow &&  highResolution
    this._startTime = this._now()
    this._stopTime = -1

  }

  public stop(): void {
    this._stopTime = this._now()
  }

  public reset() {
    this._startTime = this._now()
    this._stopTime = -1
  }

  public elapsed(): number {
    if (this._stopTime !== -1) {
      return this._stopTime - this._startTime
    }
    return this._now() - this._startTime
  }

  private _now() {
    return this._highResolution ? performance.now() : Date.now()
  }
}
