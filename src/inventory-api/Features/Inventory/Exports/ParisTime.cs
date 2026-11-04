namespace CineBoutique.Inventory.Api.Features.Inventory.Exports;

/// <summary>Heure locale des boutiques (Europe/Paris) pour les dates écrites dans les exports.</summary>
internal static class ParisTime
{
    private static readonly TimeZoneInfo Zone = ResolveZone();

    public static DateTime FromUtc(DateTimeOffset utc) => TimeZoneInfo.ConvertTime(utc, Zone).DateTime;

    public static DateTime FromUtc(DateTime utc) =>
        FromUtc(new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)));

    private static TimeZoneInfo ResolveZone()
    {
        foreach (var id in new[] { "Europe/Paris", "Romance Standard Time" })
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById(id);
            }
            catch (TimeZoneNotFoundException)
            {
            }
            catch (InvalidTimeZoneException)
            {
            }
        }

        return TimeZoneInfo.Utc;
    }
}
