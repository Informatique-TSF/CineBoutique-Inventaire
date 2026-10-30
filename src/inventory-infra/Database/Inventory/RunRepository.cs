using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CineBoutique.Inventory.Infrastructure.Database;
using CineBoutique.Inventory.Infrastructure.Database.Inventory.InternalRows;
using Dapper;

namespace CineBoutique.Inventory.Infrastructure.Database.Inventory;

public sealed class RunRepository : IRunRepository
{
    private readonly IDbConnectionFactory _connectionFactory;

    public RunRepository(IDbConnectionFactory connectionFactory)
    {
        _connectionFactory = connectionFactory ?? throw new ArgumentNullException(nameof(connectionFactory));
    }

    public async Task<InventorySummaryModel> GetSummaryAsync(Guid shopId, CancellationToken cancellationToken)
    {
        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        var hasIsActiveColumn = await InventoryDbUtilities
            .ColumnExistsAsync(connection, "CountingRun", "IsActive", cancellationToken)
            .ConfigureAwait(false);

        var activitySources = new List<string>
        {
            """
SELECT MAX(cl."CountedAtUtc") AS value
FROM "CountLine" cl
JOIN "CountingRun" cr ON cr."Id" = cl."CountingRunId"
JOIN "Location" l ON l."Id" = cr."LocationId"
WHERE l."ShopId" = @ShopId
""",
            """
SELECT MAX(cr."StartedAtUtc") AS value
FROM "CountingRun" cr
JOIN "Location" l ON l."Id" = cr."LocationId"
WHERE l."ShopId" = @ShopId
""",
            """
SELECT MAX(cr."CompletedAtUtc") AS value
FROM "CountingRun" cr
JOIN "Location" l ON l."Id" = cr."LocationId"
WHERE l."ShopId" = @ShopId
"""
        };

        if (await InventoryDbUtilities
                .TableExistsAsync(connection, "Audit", cancellationToken)
                .ConfigureAwait(false))
        {
            activitySources.Insert(0,
                """
SELECT MAX(a."CreatedAtUtc") AS value
FROM "Audit" a
WHERE EXISTS (
    SELECT 1
    FROM "CountingRun" cr
    JOIN "Location" l ON l."Id" = cr."LocationId"
    WHERE l."ShopId" = @ShopId
      AND a."EntityId" = cr."Id"::text
)
""");
        }

        var activityUnion = string.Join("\n            UNION ALL\n            ", activitySources);

        var summarySql = string.Format(
            CultureInfo.InvariantCulture,
            """
SELECT
    (
        SELECT COUNT(DISTINCT cr."InventorySessionId")
        FROM "CountingRun" cr
        JOIN "InventorySession" s ON s."Id" = cr."InventorySessionId"
        JOIN "Location" l ON l."Id" = cr."LocationId"
        WHERE s."CompletedAtUtc" IS NULL
          AND l."ShopId" = @ShopId
    ) AS "ActiveSessions",
    (
        SELECT MAX(value)
        FROM (
            {0}
        ) AS activity
    ) AS "LastActivityUtc";
""",
            activityUnion);

        var summaryRow = await connection
            .QueryFirstOrDefaultAsync<InventorySummaryRow>(
                new CommandDefinition(summarySql, new { ShopId = shopId }, cancellationToken: cancellationToken))
            .ConfigureAwait(false) ?? new InventorySummaryRow();

        var summary = new InventorySummaryModel
        {
            ActiveSessions = summaryRow.ActiveSessions,
            LastActivityUtc = summaryRow.LastActivityUtc
        };

        var openRunsSql = $"""
SELECT
    cr."Id"           AS "RunId",
    cr."LocationId",
    l."Code"          AS "LocationCode",
    l."Label"         AS "LocationLabel",
    cr."CountType",
    COALESCE(su."DisplayName", NULL) AS "OwnerDisplayName",
    cr."OwnerUserId",
    cr."StartedAtUtc"
FROM "CountingRun" cr
JOIN "Location" l ON l."Id" = cr."LocationId"
LEFT JOIN "ShopUser" su ON su."Id" = cr."OwnerUserId" AND su."ShopId" = l."ShopId"
WHERE l."ShopId" = @ShopId
  AND cr."CompletedAtUtc" IS NULL
{(hasIsActiveColumn ? "  AND cr.\"IsActive\" = TRUE\n" : string.Empty)}ORDER BY cr."StartedAtUtc" DESC;
""";

        var openRunRows = (await connection
                .QueryAsync<OpenRunSummaryRow>(
                    new CommandDefinition(openRunsSql, new { ShopId = shopId }, cancellationToken: cancellationToken))
                .ConfigureAwait(false))
            .Select(row => new OpenRunSummaryModel
            {
                RunId = row.RunId,
                LocationId = row.LocationId,
                LocationCode = row.LocationCode,
                LocationLabel = row.LocationLabel,
                CountType = row.CountType,
                OwnerUserId = row.OwnerUserId,
                OwnerDisplayName = Normalize(row.OwnerDisplayName),
                StartedAtUtc = row.StartedAtUtc
            })
            .ToArray();

        summary.OpenRuns = openRunRows;

        const string completedRunsSql = """
SELECT
    cr."Id"           AS "RunId",
    cr."LocationId",
    l."Code"          AS "LocationCode",
    l."Label"         AS "LocationLabel",
    cr."CountType",
    COALESCE(su."DisplayName", NULL) AS "OwnerDisplayName",
    cr."OwnerUserId",
    cr."StartedAtUtc",
    cr."CompletedAtUtc"
FROM "CountingRun" cr
JOIN "Location" l ON l."Id" = cr."LocationId"
LEFT JOIN "ShopUser" su ON su."Id" = cr."OwnerUserId" AND su."ShopId" = l."ShopId"
WHERE l."ShopId" = @ShopId
  AND cr."CompletedAtUtc" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "CountLine" cl WHERE cl."CountingRunId" = cr."Id")
ORDER BY cr."CompletedAtUtc" DESC;
""";

        var completedRunRows = (await connection
                .QueryAsync<CompletedRunSummaryRow>(
                    new CommandDefinition(completedRunsSql, new { ShopId = shopId }, cancellationToken: cancellationToken))
                .ConfigureAwait(false))
            .Select(row => new CompletedRunSummaryModel
            {
                RunId = row.RunId,
                LocationId = row.LocationId,
                LocationCode = row.LocationCode,
                LocationLabel = row.LocationLabel,
                CountType = row.CountType,
                OwnerUserId = row.OwnerUserId,
                OwnerDisplayName = Normalize(row.OwnerDisplayName),
                StartedAtUtc = row.StartedAtUtc,
                CompletedAtUtc = row.CompletedAtUtc
            })
            .ToArray();

        summary.CompletedRuns = completedRunRows;

        const string conflictZonesSql = """
SELECT
    cr."LocationId" AS "LocationId",
    l."Code"        AS "LocationCode",
    l."Label"       AS "LocationLabel",
    COUNT(*)::int      AS "ConflictLines"
FROM "Conflict" c
JOIN "CountLine"  cl ON cl."Id" = c."CountLineId"
JOIN "CountingRun" cr ON cr."Id" = cl."CountingRunId"
JOIN "Location"    l ON l."Id" = cr."LocationId"
WHERE c."IsResolved" = FALSE
  AND l."ShopId" = @ShopId
GROUP BY cr."LocationId", l."Code", l."Label"
ORDER BY l."Code";
""";

        var conflictZones = (await connection
                .QueryAsync<ConflictZoneSummaryRow>(
                    new CommandDefinition(conflictZonesSql, new { ShopId = shopId }, cancellationToken: cancellationToken))
                .ConfigureAwait(false))
            .Select(row => new ConflictZoneSummaryModel
            {
                LocationId = row.LocationId,
                LocationCode = row.LocationCode,
                LocationLabel = row.LocationLabel,
                ConflictLines = row.ConflictLines
            })
            .ToArray();

        summary.ConflictZones = conflictZones;

        return summary;
    }

    public async Task<CompletedRunDetailModel?> GetCompletedRunDetailAsync(Guid runId, CancellationToken cancellationToken)
    {
        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        var columnsState = await InventoryOperatorSqlHelper
            .DetectOperatorColumnsAsync(connection, cancellationToken)
            .ConfigureAwait(false);
        var runOperatorSql = InventoryOperatorSqlHelper.BuildOperatorSqlFragments("cr", "owner", columnsState);

        var runSql = $"""
SELECT
    cr."Id"           AS "RunId",
    cr."LocationId",
    l."Code"          AS "LocationCode",
    l."Label"         AS "LocationLabel",
    cr."CountType",
    {runOperatorSql.Projection} AS "OperatorDisplayName",
    cr."StartedAtUtc",
    cr."CompletedAtUtc"
FROM "CountingRun" cr
JOIN "Location" l ON l."Id" = cr."LocationId"
{InventoryOperatorSqlHelper.AppendJoinClause(runOperatorSql.JoinClause)}
WHERE cr."Id" = @RunId
  AND cr."CompletedAtUtc" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "CountLine" cl WHERE cl."CountingRunId" = cr."Id")
LIMIT 1;
""";

        var runRow = await connection
            .QuerySingleOrDefaultAsync<CompletedRunDetailRow?>(
                new CommandDefinition(runSql, new { RunId = runId }, cancellationToken: cancellationToken))
            .ConfigureAwait(false);

        if (runRow is null)
        {
            return null;
        }

        const string linesSql = """
SELECT
    cl."ProductId" AS "ProductId",
    p."Sku"        AS "Sku",
    p."Name"       AS "Name",
    p."Ean"        AS "Ean",
    cl."Quantity"  AS "Quantity"
FROM "CountLine" cl
JOIN "Product" p ON p."Id" = cl."ProductId"
WHERE cl."CountingRunId" = @RunId
ORDER BY COALESCE(p."Ean", p."Sku"), p."Name";
""";

        var lines = (await connection
                .QueryAsync<CompletedRunLineRow>(
                    new CommandDefinition(linesSql, new { RunId = runId }, cancellationToken: cancellationToken))
                .ConfigureAwait(false))
            .Select(row => new CompletedRunLineModel
            {
                ProductId = row.ProductId,
                Sku = row.Sku,
                Name = row.Name,
                Ean = row.Ean,
                Quantity = row.Quantity
            })
            .ToArray();

        return new CompletedRunDetailModel
        {
            RunId = runRow.RunId,
            LocationId = runRow.LocationId,
            LocationCode = runRow.LocationCode,
            LocationLabel = runRow.LocationLabel,
            CountType = runRow.CountType,
            OperatorDisplayName = Normalize(runRow.OperatorDisplayName),
            StartedAtUtc = runRow.StartedAtUtc,
            CompletedAtUtc = runRow.CompletedAtUtc,
            Items = lines
        };
    }

    public async Task<IReadOnlyList<FinalizedZoneSummaryModel>> GetFinalizedZoneSummariesAsync(Guid shopId, CancellationToken cancellationToken)
    {
        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        const string latestRunsSql = """
WITH completed_runs AS (
    SELECT
        cr."Id"               AS "RunId",
        cr."LocationId"       AS "LocationId",
        l."Code"              AS "LocationCode",
        l."Label"             AS "LocationLabel",
        cr."CountType"        AS "CountType",
        cr."CompletedAtUtc"   AS "CompletedAtUtc",
        COALESCE(su."DisplayName", cr."OperatorDisplayName") AS "OperatorDisplayName",
        ROW_NUMBER() OVER (
            PARTITION BY cr."LocationId"
            ORDER BY cr."CountType" DESC, cr."CompletedAtUtc" DESC, cr."Id" DESC
        ) AS rn
    FROM "CountingRun" cr
    JOIN "Location" l ON l."Id" = cr."LocationId"
    LEFT JOIN "ShopUser" su ON su."Id" = cr."OwnerUserId" AND su."ShopId" = l."ShopId"
    WHERE l."ShopId" = @ShopId
      AND cr."CompletedAtUtc" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "CountLine" cl WHERE cl."CountingRunId" = cr."Id")
)
SELECT
    "RunId",
    "LocationId",
    "LocationCode",
    "LocationLabel",
    "CountType",
    "CompletedAtUtc",
    "OperatorDisplayName"
FROM completed_runs
WHERE rn = 1
ORDER BY LOWER(COALESCE(NULLIF("LocationCode", ''), "LocationLabel")), "RunId";
""";

        var runRows = (await connection
                .QueryAsync<FinalizedZoneSummaryRow>(
                    new CommandDefinition(latestRunsSql, new { ShopId = shopId }, cancellationToken: cancellationToken))
                .ConfigureAwait(false))
            .ToArray();

        if (runRows.Length == 0)
        {
            return Array.Empty<FinalizedZoneSummaryModel>();
        }

        var runIds = runRows.Select(row => row.RunId).Distinct().ToArray();

        const string itemsSql = """
SELECT
    cl."CountingRunId" AS "RunId",
    p."Ean"            AS "Ean",
    p."Sku"            AS "Sku",
    p."Name"           AS "Name",
    SUM(cl."Quantity") AS "Quantity"
FROM "CountLine" cl
JOIN "Product" p ON p."Id" = cl."ProductId"
WHERE cl."CountingRunId" = ANY(@RunIds)
GROUP BY cl."CountingRunId", p."Ean", p."Sku", p."Name"
ORDER BY cl."CountingRunId",
         COALESCE(NULLIF(p."Sku", ''), p."Ean"),
         COALESCE(p."Name", '');
""";

        var itemRows = await connection
            .QueryAsync<FinalizedZoneItemRow>(
                new CommandDefinition(itemsSql, new { RunIds = runIds }, cancellationToken: cancellationToken))
            .ConfigureAwait(false);

        var itemsLookup = itemRows
            .GroupBy(row => row.RunId)
            .ToDictionary(
                group => group.Key,
                group => group
                    .Select(item => new FinalizedZoneItemModel
                    {
                        Ean = item.Ean?.Trim() ?? string.Empty,
                        Sku = item.Sku?.Trim() ?? string.Empty,
                        Name = item.Name?.Trim() ?? string.Empty,
                        Quantity = item.Quantity
                    })
                    .ToArray(),
                EqualityComparer<Guid>.Default);

        var summaries = new FinalizedZoneSummaryModel[runRows.Length];
        for (var index = 0; index < runRows.Length; index++)
        {
            var row = runRows[index];
            var items = itemsLookup.TryGetValue(row.RunId, out var zoneItems)
                ? zoneItems
                : Array.Empty<FinalizedZoneItemModel>();

            summaries[index] = new FinalizedZoneSummaryModel
            {
                RunId = row.RunId,
                LocationId = row.LocationId,
                LocationCode = row.LocationCode ?? string.Empty,
                LocationLabel = row.LocationLabel ?? string.Empty,
                CountType = row.CountType,
                CompletedAtUtc = DateTime.SpecifyKind(row.CompletedAtUtc, DateTimeKind.Utc),
                OperatorDisplayName = Normalize(row.OperatorDisplayName),
                Items = items
            };
        }

        return summaries;
    }

    public async Task<ActiveRunLookupResult> FindActiveRunAsync(
        Guid locationId,
        short countType,
        Guid ownerUserId,
        Guid? sessionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await _connectionFactory.CreateOpenConnectionAsync(cancellationToken).ConfigureAwait(false);

        Guid targetSessionId;
        if (sessionId.HasValue)
        {
            targetSessionId = sessionId.Value;
        }
        else
        {
            const string selectActiveSession = """
SELECT "Id"
FROM "InventorySession"
WHERE "CompletedAtUtc" IS NULL
ORDER BY "StartedAtUtc" DESC
LIMIT 1;
""";
            var resolvedSessionId = await connection.QuerySingleOrDefaultAsync<Guid?>(
                    new CommandDefinition(selectActiveSession, cancellationToken: cancellationToken))
                .ConfigureAwait(false);

            if (!resolvedSessionId.HasValue)
            {
                return new ActiveRunLookupResult
                {
                    Status = ActiveRunLookupStatus.NoActiveSession,
                    OwnerUserId = ownerUserId,
                    CountType = countType
                };
            }

            targetSessionId = resolvedSessionId.Value;
        }

        var columnsState = await InventoryOperatorSqlHelper
            .DetectOperatorColumnsAsync(connection, cancellationToken)
            .ConfigureAwait(false);
        var runOperatorSql = InventoryOperatorSqlHelper.BuildOperatorSqlFragments("cr", "owner", columnsState);

        string? ownerDisplayName = null;
        if (columnsState.HasOperatorDisplayName || columnsState.HasOwnerUserId)
        {
            const string selectOwnerDisplayNameSql = """
SELECT "DisplayName" FROM "ShopUser" WHERE "Id" = @OwnerUserId LIMIT 1;
""";

            ownerDisplayName = await connection
                .ExecuteScalarAsync<string?>(
                    new CommandDefinition(selectOwnerDisplayNameSql, new { OwnerUserId = ownerUserId }, cancellationToken: cancellationToken))
                .ConfigureAwait(false);

            ownerDisplayName = Normalize(ownerDisplayName);
        }

        string selectRunSql;
        object parameters;

        if (columnsState.HasOwnerUserId)
        {
            selectRunSql = $"""
SELECT cr."Id" AS "RunId", cr."LocationId", cr."StartedAtUtc", {runOperatorSql.Projection} AS "OperatorDisplayName", cr."OwnerUserId"
FROM "CountingRun" cr
{InventoryOperatorSqlHelper.AppendJoinClause(runOperatorSql.JoinClause)}
WHERE cr."InventorySessionId" = @SessionId
  AND cr."LocationId"        = @LocationId
  AND cr."CountType"         = @CountType
  AND cr."OwnerUserId"       = @OwnerUserId
  AND cr."CompletedAtUtc" IS NULL
  AND EXISTS (SELECT 1 FROM "CountLine" cl WHERE cl."CountingRunId" = cr."Id")
ORDER BY cr."StartedAtUtc" DESC
LIMIT 1;
""";

            parameters = new
            {
                SessionId = targetSessionId,
                LocationId = locationId,
                CountType = countType,
                OwnerUserId = ownerUserId
            };
        }
        else if (columnsState.HasOperatorDisplayName)
        {
            if (string.IsNullOrWhiteSpace(ownerDisplayName))
            {
                return new ActiveRunLookupResult
                {
                    Status = ActiveRunLookupStatus.OwnerDisplayNameMissing,
                    OwnerUserId = ownerUserId,
                    CountType = countType,
                    SessionId = targetSessionId
                };
            }

            selectRunSql = $"""
SELECT cr."Id" AS "RunId", cr."LocationId", cr."StartedAtUtc", {runOperatorSql.Projection} AS "OperatorDisplayName", NULL::uuid AS "OwnerUserId"
FROM "CountingRun" cr
{InventoryOperatorSqlHelper.AppendJoinClause(runOperatorSql.JoinClause)}
WHERE cr."InventorySessionId" = @SessionId
  AND cr."LocationId"        = @LocationId
  AND cr."CountType"         = @CountType
  AND COALESCE(cr."OperatorDisplayName", '') = @OperatorDisplayName
  AND cr."CompletedAtUtc" IS NULL
  AND EXISTS (SELECT 1 FROM "CountLine" cl WHERE cl."CountingRunId" = cr."Id")
ORDER BY cr."StartedAtUtc" DESC
LIMIT 1;
""";

            parameters = new
            {
                SessionId = targetSessionId,
                LocationId = locationId,
                CountType = countType,
                OperatorDisplayName = ownerDisplayName
            };
        }
        else
        {
            return new ActiveRunLookupResult
            {
                Status = ActiveRunLookupStatus.OperatorNotSupported,
                OwnerUserId = ownerUserId,
                CountType = countType,
                SessionId = targetSessionId
            };
        }

        var runRow = await connection
            .QuerySingleOrDefaultAsync<ActiveRunRow?>(
                new CommandDefinition(selectRunSql, parameters, cancellationToken: cancellationToken))
            .ConfigureAwait(false);

        if (runRow is null)
        {
            return new ActiveRunLookupResult
            {
                Status = ActiveRunLookupStatus.RunNotFound,
                OwnerUserId = ownerUserId,
                CountType = countType,
                SessionId = targetSessionId,
                OwnerDisplayName = ownerDisplayName
            };
        }

        return new ActiveRunLookupResult
        {
            Status = ActiveRunLookupStatus.Success,
            SessionId = targetSessionId,
            OwnerDisplayName = ownerDisplayName,
            OwnerUserId = runRow.OwnerUserId ?? ownerUserId,
            CountType = countType,
            Run = new ActiveRunModel
            {
                RunId = runRow.RunId,
                LocationId = runRow.LocationId,
                OwnerUserId = runRow.OwnerUserId,
                OperatorDisplayName = Normalize(runRow.OperatorDisplayName) ?? ownerDisplayName,
                StartedAtUtc = runRow.StartedAtUtc
            }
        };
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
