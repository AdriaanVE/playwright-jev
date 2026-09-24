export default function createProvider(options) {
  return {
    name: "fixture",
    async decide(request) {
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, { type: "noul", noul: options.p }]),
      )
      return { answers }
    },
  }
}
