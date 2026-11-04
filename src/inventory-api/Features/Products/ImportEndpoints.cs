using System.Data;
using CineBoutique.Inventory.Api.Endpoints;
using CineBoutique.Inventory.Api.Infrastructure.Minimal;
using CineBoutique.Inventory.Api.Models;
using CineBoutique.Inventory.Api.Services.Products;
using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;

namespace CineBoutique.Inventory.Api.Features.Products;

internal static class ImportEndpoints
{
    public static IEndpointRouteBuilder MapProductImportEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        MapShopImportEndpoints(app);

        return app;
    }

    private static void MapShopImportEndpoints(IEndpointRouteBuilder app)
    {
        // IMPORT CSV PAR BOUTIQUE (écrase ou merge selon service d'import)
        app.MapPost("/api/shops/{shopId:guid}/products/import", async (
            Guid shopId,
            HttpRequest request,
            IDbConnection connection,
            CineBoutique.Inventory.Infrastructure.Locks.IImportLockService importLockService,
            string? dryRun,
            string? mode,
            CancellationToken ct) =>
        {
            var lockHandle = await importLockService.TryAcquireForShopAsync(shopId, ct).ConfigureAwait(false);
            if (lockHandle is null)
                return Results.Json(new { reason = "import_in_progress" }, statusCode: StatusCodes.Status423Locked);

            await using (lockHandle)
            {
                await EndpointUtilities.EnsureConnectionOpenAsync(connection, ct).ConfigureAwait(false);

                var importMode = ParseImportMode(mode);

                // dryRun (bool)
                var isDryRun = false;
                if (!string.IsNullOrWhiteSpace(dryRun) && bool.TryParse(dryRun, out var b)) isDryRun = b;

                // 25 MiB
                const long maxCsvSizeBytes = 25L * 1024L * 1024L;
                if (request.ContentLength is { } len && len > maxCsvSizeBytes)
                    return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

                // Récupération du flux CSV
                Stream csvStream;
                if (request.HasFormContentType)
                {
                    var form = await request.ReadFormAsync(ct).ConfigureAwait(false);
                    var file = form.Files.GetFile("file");
                    if (file is null || file.Length == 0) return Results.BadRequest(new { reason = "MISSING_FILE" });
                    if (file.Length > maxCsvSizeBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                    csvStream = file.OpenReadStream();
                }
                else
                {
                    var contentType = (request.ContentType ?? string.Empty).Trim();
                    var looksCsv =
                        contentType.StartsWith("text/csv", System.StringComparison.OrdinalIgnoreCase) ||
                        contentType.StartsWith("application/octet-stream", System.StringComparison.OrdinalIgnoreCase) ||
                        contentType.StartsWith("application/vnd.ms-excel", System.StringComparison.OrdinalIgnoreCase) ||
                        contentType.StartsWith("text/plain", System.StringComparison.OrdinalIgnoreCase);

                    if (!looksCsv)
                        return Results.BadRequest(new { reason = "UNSUPPORTED_CONTENT_TYPE" });
                    csvStream = request.Body;
                }

                var user = EndpointUtilities.GetAuthenticatedUserName(request.HttpContext);
                var importService = request.HttpContext.RequestServices.GetRequiredService<IProductImportService>();
                var cmd = new ProductImportCommand(csvStream, isDryRun, user, shopId, importMode);

                try
                {
                    var result = await importService.ImportAsync(cmd, ct).ConfigureAwait(false);

                    return result.ResultType switch
                    {
                        ProductImportResultType.ValidationFailed => Results.BadRequest(result.Response),
                        ProductImportResultType.Skipped => Results.StatusCode(StatusCodes.Status204NoContent),
                        _ => Results.Ok(result.Response)
                    };
                }
                catch (ProductImportBlockedException blockedException)
                {
                    var extensions = new Dictionary<string, object?>
                    {
                        ["blocked"] = new
                        {
                            sampleProductIds = blockedException.SampleProductIds,
                            locationId = blockedException.LocationId
                        }
                    };

                    return Results.Problem(
                        detail: "Certains produits sont utilisés dans des comptages. Désactivez d’abord la zone ou réinitialisez son comptage.",
                        statusCode: StatusCodes.Status409Conflict,
                        title: "Suppression impossible",
                        extensions: extensions);
                }
                catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.ForeignKeyViolation)
                {
                    var problem = new ProblemDetails
                    {
                        Title = "Suppression impossible",
                        Status = StatusCodes.Status409Conflict,
                        Detail = "Cette action nécessite la réinitialisation d’un comptage existant (lignes liées).",
                        Instance = request.Path.ToString()
                    };

                    return Results.Json(problem, statusCode: StatusCodes.Status409Conflict);
                }
            }
        })
        .AddEndpointFilter<RequireOperatorHeadersFilter>()
        .AddEndpointFilter<RequireShopAdminFilter>()
        .RequireAuthorization("Admin");

        app.MapGet("/api/shops/{shopId:guid}/products/import/status", async (
            Guid shopId,
            IDbConnection connection,
            CancellationToken ct) =>
        {
            await EndpointUtilities.EnsureConnectionOpenAsync(connection, ct).ConfigureAwait(false);

            var hasCountLines = await HasCountLinesForShopAsync(shopId, connection, ct).ConfigureAwait(false);

            return Results.Ok(new
            {
                canReplace = !hasCountLines,
                lockReason = hasCountLines ? "counting_started" : null,
                hasCountLines
            });
        }).RequireAuthorization("Admin");
    }

    private static ProductImportMode ParseImportMode(string? mode)
    {
        if (string.Equals(mode, "merge", StringComparison.OrdinalIgnoreCase))
            return ProductImportMode.Merge;

        return ProductImportMode.ReplaceCatalogue;
    }

    private static async Task<bool> HasCountLinesForShopAsync(Guid shopId, IDbConnection connection, CancellationToken ct)
    {
        const string sql = @"SELECT EXISTS (
        SELECT 1
        FROM ""CountLine"" cl
        JOIN ""CountingRun"" cr ON cr.""Id"" = cl.""CountingRunId""
        JOIN ""Location"" l ON l.""Id"" = cr.""LocationId""
        WHERE l.""ShopId"" = @ShopId
    );";

        try
        {
            return await connection.ExecuteScalarAsync<bool>(
                    new Dapper.CommandDefinition(sql, new { ShopId = shopId }, cancellationToken: ct))
                .ConfigureAwait(false);
        }
        catch (PostgresException ex) when (ex.SqlState is PostgresErrorCodes.UndefinedTable or PostgresErrorCodes.UndefinedColumn)
        {
            return false;
        }
    }

}
