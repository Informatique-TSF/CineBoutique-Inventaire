using CineBoutique.Inventory.Api.Features.Inventory.Sessions;
using CineBoutique.Inventory.Api.Infrastructure.Minimal;
using CineBoutique.Inventory.Api.Models;

namespace CineBoutique.Inventory.Api.Features.Inventory;

internal static class SessionsEndpoints
{
    public static IEndpointRouteBuilder MapSessionsEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        MapStartEndpoint(app);
        MapCompleteEndpoint(app);
        MapReleaseEndpoint(app);
        MapRestartEndpoint(app);
        MapResetEndpoint(app);

        return app;
    }

    private static void MapStartEndpoint(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/inventories/{locationId:guid}/start", (
            Guid locationId,
            StartRunRequest request,
            StartInventoryRunHandler handler,
            CancellationToken cancellationToken) =>
                handler.HandleAsync(locationId, request, cancellationToken))
        .AddEndpointFilter<RequireOperatorHeadersFilter>()
        .WithName("StartInventoryRun")
        .WithTags("Inventories")
        .Produces<StartInventoryRunResponse>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status400BadRequest)
        .Produces(StatusCodes.Status404NotFound)
        .Produces(StatusCodes.Status409Conflict)
        .WithOpenApi(op =>
        {
            op.Summary = "Démarre un comptage sur une zone donnée.";
            op.Description = "Crée ou reprend un run actif pour une zone, un type de comptage et un opérateur.";
            return op;
        });
    }

    private static void MapCompleteEndpoint(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/inventories/{locationId:guid}/complete", (
            Guid locationId,
            CompleteRunRequest request,
            HttpContext httpContext,
            CompleteInventoryRunHandler handler,
            CancellationToken cancellationToken) =>
                handler.HandleAsync(locationId, request, httpContext, cancellationToken))
        .AddEndpointFilter<RequireOperatorHeadersFilter>()
        .WithName("CompleteInventoryRun")
        .WithTags("Inventories")
        .Produces<CompleteInventoryRunResponse>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status400BadRequest)
        .Produces(StatusCodes.Status404NotFound);
    }

    private static void MapReleaseEndpoint(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/inventories/{locationId:guid}/release", (
            Guid locationId,
            ReleaseRunRequest request,
            ReleaseInventoryRunHandler handler,
            CancellationToken cancellationToken) =>
                handler.HandleAsync(locationId, request, cancellationToken))
        .AddEndpointFilter<RequireOperatorHeadersFilter>()
        .WithName("ReleaseInventoryRun")
        .WithTags("Inventories")
        .Produces(StatusCodes.Status204NoContent)
        .Produces(StatusCodes.Status400BadRequest)
        .Produces(StatusCodes.Status404NotFound)
        .Produces(StatusCodes.Status409Conflict)
        .WithOpenApi(op =>
        {
            op.Summary = "Libère un comptage en cours sans le finaliser.";
            op.Description = "Supprime le run actif lorsqu'aucune ligne n'a été enregistrée, ce qui libère la zone.";
            return op;
        });

        app.MapDelete("/api/inventories/{locationId:guid}/runs/{runId:guid}", (
            Guid locationId,
            Guid runId,
            Guid ownerUserId,
            ReleaseInventoryRunHandler handler,
            CancellationToken cancellationToken) =>
                handler.HandleAsync(locationId, new ReleaseRunRequest(runId, ownerUserId), cancellationToken))
        .AddEndpointFilter<RequireOperatorHeadersFilter>()
        .WithName("AbortInventoryRun")
        .WithTags("Inventories")
        .Produces(StatusCodes.Status204NoContent)
        .Produces(StatusCodes.Status400BadRequest)
        .Produces(StatusCodes.Status404NotFound)
        .Produces(StatusCodes.Status409Conflict)
        .WithOpenApi(op =>
        {
            op.Summary = "Libère un comptage via la route historique DELETE.";
            op.Description = "Route de compatibilité acceptant ownerUserId en paramètre de requête pour libérer un run actif.";
            return op;
        });
    }

    private static void MapRestartEndpoint(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/inventories/{locationId:guid}/restart", (
            Guid locationId,
            RestartRunRequest request,
            HttpContext httpContext,
            RestartInventoryRunHandler handler,
            CancellationToken cancellationToken) =>
                handler.HandleAsync(locationId, request, httpContext, cancellationToken))
        .AddEndpointFilter<RequireOperatorHeadersFilter>()
        .WithName("RestartInventoryForLocation")
        .WithTags("Inventories")
        .Produces(StatusCodes.Status204NoContent)
        .Produces(StatusCodes.Status400BadRequest)
        .WithOpenApi(op =>
        {
            op.Summary = "Force la clôture des comptages actifs pour une zone et un type donnés.";
            op.Description = "Permet de terminer les runs ouverts sur une zone pour relancer un nouveau comptage.";
            return op;
        });
    }

    private static void MapResetEndpoint(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/shops/{shopId:guid}/inventories/reset", (
            Guid shopId,
            HttpContext httpContext,
            ResetShopInventoryHandler handler,
            CancellationToken cancellationToken) =>
                handler.HandleAsync(shopId, httpContext, cancellationToken))
        .AddEndpointFilter<RequireOperatorHeadersFilter>()
        .AddEndpointFilter<RequireShopAdminFilter>()
        .WithName("ResetShopInventory")
        .WithTags("Inventories")
        .Produces<ResetShopInventoryResponse>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status400BadRequest)
        .WithOpenApi(op =>
        {
            op.Summary = "Réinitialise l’inventaire pour une boutique.";
            op.Description = "Supprime tous les comptages et conflits associés à la boutique pour démarrer un nouvel inventaire.";
            return op;
        });
    }
}
