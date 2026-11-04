using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Dapper;

namespace CineBoutique.Inventory.Infrastructure.Database.Inventory;

public sealed class InventoryExportRepository : IInventoryExportRepository
{
    private const string ShopSql = """
SELECT "Id" AS "ShopId", "Name" AS "ShopName", "OfficeCode"
FROM "Shop"
WHERE "Id" = @ShopId;
""";

    private const string ZonesSql = """
SELECT "Id" AS "LocationId", "Code", "Label"
FROM "Location"
WHERE "ShopId" = @ShopId
  AND "Disabled" = FALSE
ORDER BY UPPER("Code"), "Label";
""";

    // Comme l'écran d'accueil : le dernier comptage terminé par zone et par numéro de comptage.
    private const string CompletedRunsSql = """
SELECT DISTINCT ON (cr."LocationId", cr."CountType")
    cr."Id"             AS "RunId",
    cr."LocationId"     AS "LocationId",
    cr."CountType"      AS "CountType",
    cr."CompletedAtUtc" AS "CompletedAtUtc",
    COALESCE(su."DisplayName", cr."OperatorDisplayName") AS "OperatorDisplayName"
FROM "CountingRun" cr
JOIN "Location" l ON l."Id" = cr."LocationId"
LEFT JOIN "ShopUser" su ON su."Id" = cr."OwnerUserId" AND su."ShopId" = l."ShopId"
WHERE l."ShopId" = @ShopId
  AND l."Disabled" = FALSE
  AND cr."CompletedAtUtc" IS NOT NULL
ORDER BY cr."LocationId", cr."CountType", cr."CompletedAtUtc" DESC, cr."Id" DESC;
""";

    private const string OpenRunsSql = """
SELECT
    cr."LocationId" AS "LocationId",
    cr."CountType"  AS "CountType",
    COALESCE(su."DisplayName", cr."OperatorDisplayName") AS "OperatorDisplayName"
FROM "CountingRun" cr
JOIN "Location" l ON l."Id" = cr."LocationId"
LEFT JOIN "ShopUser" su ON su."Id" = cr."OwnerUserId" AND su."ShopId" = l."ShopId"
WHERE l."ShopId" = @ShopId
  AND l."Disabled" = FALSE
  AND cr."CompletedAtUtc" IS NULL;
""";

    private const string LinesSql = """
SELECT
    cl."CountingRunId" AS "RunId",
    p."Id"             AS "ProductId",
    p."Sku"            AS "Sku",
    p."Ean"            AS "Ean",
    p."Name"           AS "Name",
    SUM(cl."Quantity") AS "Quantity"
FROM "CountLine" cl
JOIN "Product" p ON p."Id" = cl."ProductId"
WHERE cl."CountingRunId" = ANY(@RunIds)
GROUP BY cl."CountingRunId", p."Id", p."Sku", p."Ean", p."Name";
""";

    private readonly IDbConnectionFactory _connectionFactory;

    public InventoryExportRepository(IDbConnectionFactory connectionFactory)
    {
        _connectionFactory = connectionFactory ?? throw new ArgumentNullException(nameof(connectionFactory));
    }

    public async Task<InventoryExportSnapshot?> GetSnapshotAsync(Guid shopId, CancellationToken cancellationToken)
    {
        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        var parameters = new { ShopId = shopId };

        var shop = await connection
            .QuerySingleOrDefaultAsync<InventoryExportShopRow>(new CommandDefinition(ShopSql, parameters, cancellationToken: cancellationToken))
            .ConfigureAwait(false);

        if (shop is null)
        {
            return null;
        }

        var zones = (await connection
                .QueryAsync<InventoryExportZone>(new CommandDefinition(ZonesSql, parameters, cancellationToken: cancellationToken))
                .ConfigureAwait(false))
            .ToArray();

        var completedRuns = (await connection
                .QueryAsync<InventoryExportRun>(new CommandDefinition(CompletedRunsSql, parameters, cancellationToken: cancellationToken))
                .ConfigureAwait(false))
            .Select(run =>
            {
                run.CompletedAtUtc = DateTime.SpecifyKind(run.CompletedAtUtc, DateTimeKind.Utc);
                return run;
            })
            .ToArray();

        var openRuns = (await connection
                .QueryAsync<InventoryExportOpenRun>(new CommandDefinition(OpenRunsSql, parameters, cancellationToken: cancellationToken))
                .ConfigureAwait(false))
            .ToArray();

        var lines = Array.Empty<InventoryExportLine>();
        if (completedRuns.Length > 0)
        {
            var runIds = completedRuns.Select(run => run.RunId).ToArray();
            lines = (await connection
                    .QueryAsync<InventoryExportLine>(new CommandDefinition(LinesSql, new { RunIds = runIds }, cancellationToken: cancellationToken))
                    .ConfigureAwait(false))
                .ToArray();
        }

        return new InventoryExportSnapshot
        {
            ShopId = shop.ShopId,
            ShopName = shop.ShopName,
            OfficeCode = string.IsNullOrWhiteSpace(shop.OfficeCode) ? null : shop.OfficeCode.Trim(),
            Zones = zones,
            CompletedRuns = completedRuns,
            OpenRuns = openRuns,
            Lines = lines
        };
    }
}

internal sealed class InventoryExportShopRow
{
    public Guid ShopId { get; set; }

    public string ShopName { get; set; } = string.Empty;

    public string? OfficeCode { get; set; }
}
