export default {
  async fetch() {
    const cartoApiKey =
      process.env.CARTO_API_KEY?.trim() ||
      process.env.carto_api_key?.trim() ||
      "";

    return Response.json(
      { cartoApiKey },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        },
      },
    );
  },
};
