using CineBoutique.Inventory.Api.Endpoints;
using CineBoutique.Inventory.Api.Infrastructure.Audit;
using CineBoutique.Inventory.Api.Infrastructure.Minimal;
using CineBoutique.Inventory.Api.Infrastructure.Time;
using CineBoutique.Inventory.Api.Models;
using CineBoutique.Inventory.Api.Services;
using CineBoutique.Inventory.Api.Services.Exceptions;
using FluentValidation;
using Microsoft.AspNetCore.Mvc;

namespace CineBoutique.Inventory.Api.Features.Shops;

internal static class ShopUsersEndpoints
{
    public static IEndpointRouteBuilder MapShopUsersEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        var group = app.MapGroup("/api/shops/{shopId:guid}/users")
            .WithTags("ShopUsers");

        MapGetShopUsersEndpoint(group);
        MapCreateShopUserEndpoint(group);
        MapUpdateShopUserEndpoint(group);
        MapDeleteShopUserEndpoint(group);

        return app;
    }

    private static void MapGetShopUsersEndpoint(RouteGroupBuilder group)
    {
        ArgumentNullException.ThrowIfNull(group);

        group.MapGet(
                string.Empty,
                async (
                    [FromRoute(Name = "shopId")] Guid shopId,
                    [FromQuery(Name = "includeDisabled")] bool? includeDisabled,
                    [FromServices] IShopUserService shopUserService,
                    CancellationToken cancellationToken) =>
                {
                    try
                    {
                        var users = await shopUserService.GetAsync(
                                shopId,
                                includeDisabled.GetValueOrDefault(false),
                                cancellationToken)
                            .ConfigureAwait(false);
                        return Results.Ok(users);
                    }
                    catch (ShopNotFoundException ex)
                    {
                        return Results.NotFound(BuildProblem(ex.Message, StatusCodes.Status404NotFound));
                    }
                })
            .WithTags("ShopUsers")
            .WithOpenApi(operation =>
            {
                operation.Summary = "Lister les utilisateurs magasin";
                operation.Description = "Retourne les utilisateurs d'une boutique, avec les comptes désactivés si demandé.";
                return operation;
            })
            .Produces<IReadOnlyList<ShopUserDto>>(StatusCodes.Status200OK)
            .Produces<ProblemDetails>(StatusCodes.Status404NotFound)
            .RequireAuthorization();
    }

    private static void MapCreateShopUserEndpoint(RouteGroupBuilder group)
    {
        ArgumentNullException.ThrowIfNull(group);

        group.MapPost(
                string.Empty,
                async (
                    [FromRoute(Name = "shopId")] Guid shopId,
                    [FromBody] CreateShopUserRequest? request,
                    [FromServices] IShopUserService shopUserService,
                    [FromServices] IAuditLogger auditLogger,
                    [FromServices] IClock clock,
                    [FromServices] IValidator<CreateShopUserRequest> validator,
                    HttpContext httpContext,
                    CancellationToken cancellationToken) =>
                {
                    if (request is null)
                    {
                        return EndpointUtilities.Problem(
                            "Requête invalide",
                            "Le corps de la requête est requis.",
                            StatusCodes.Status400BadRequest);
                    }

                    var validationResult = await validator.ValidateAsync(request, cancellationToken).ConfigureAwait(false);
                    if (!validationResult.IsValid)
                        return EndpointUtilities.ValidationProblem(validationResult);

                    try
                    {
                        var created = await shopUserService.CreateAsync(shopId, request, cancellationToken).ConfigureAwait(false);

                        await LogUserChangeAsync(
                                shopId,
                                $"a créé l'utilisateur '{created.Login}' ({created.Id}).",
                                "shop_users.create.success",
                                clock,
                                auditLogger,
                                httpContext,
                                cancellationToken)
                            .ConfigureAwait(false);

                        return Results.Created($"/api/shops/{shopId}/users/{created.Id}", created);
                    }
                    catch (ShopNotFoundException ex)
                    {
                        return Results.NotFound(BuildProblem(ex.Message, StatusCodes.Status404NotFound));
                    }
                    catch (ShopUserConflictException ex)
                    {
                        return Results.Conflict(BuildConflictProblem(ex.Message));
                    }
                })
            .WithTags("ShopUsers")
            .WithOpenApi(operation =>
            {
                operation.Summary = "Créer un utilisateur magasin";
                operation.Description = "Ajoute un utilisateur à la boutique et renvoie les informations de la ressource créée.";
                return operation;
            })
            .Produces<ShopUserDto>(StatusCodes.Status201Created)
            .Produces<ProblemDetails>(StatusCodes.Status400BadRequest)
            .Produces<ProblemDetails>(StatusCodes.Status404NotFound)
            .Produces<ProblemDetails>(StatusCodes.Status409Conflict)
            .AddEndpointFilter<RequireOperatorHeadersFilter>()
            .AddEndpointFilter<RequireShopAdminFilter>()
            .RequireAuthorization("Admin");
    }

    private static void MapUpdateShopUserEndpoint(RouteGroupBuilder group)
    {
        ArgumentNullException.ThrowIfNull(group);

        group.MapPut(
                string.Empty,
                async (
                    [FromRoute(Name = "shopId")] Guid shopId,
                    [FromBody] UpdateShopUserRequest? request,
                    [FromServices] IShopUserService shopUserService,
                    [FromServices] IAuditLogger auditLogger,
                    [FromServices] IClock clock,
                    [FromServices] IValidator<UpdateShopUserRequest> validator,
                    HttpContext httpContext,
                    CancellationToken cancellationToken) =>
                {
                    if (request is null)
                    {
                        return EndpointUtilities.Problem(
                            "Requête invalide",
                            "Le corps de la requête est requis.",
                            StatusCodes.Status400BadRequest);
                    }

                    var validationResult = await validator.ValidateAsync(request, cancellationToken).ConfigureAwait(false);
                    if (!validationResult.IsValid)
                        return EndpointUtilities.ValidationProblem(validationResult);

                    try
                    {
                        var updated = await shopUserService.UpdateAsync(shopId, request, cancellationToken).ConfigureAwait(false);

                        await LogUserChangeAsync(
                                shopId,
                                $"a mis à jour l'utilisateur '{updated.Login}' ({updated.Id}).",
                                "shop_users.update.success",
                                clock,
                                auditLogger,
                                httpContext,
                                cancellationToken)
                            .ConfigureAwait(false);

                        return Results.Ok(updated);
                    }
                    catch (ShopNotFoundException ex)
                    {
                        return Results.NotFound(BuildProblem(ex.Message, StatusCodes.Status404NotFound));
                    }
                    catch (ShopUserNotFoundException ex)
                    {
                        return Results.NotFound(BuildProblem(ex.Message, StatusCodes.Status404NotFound));
                    }
                    catch (ShopUserConflictException ex)
                    {
                        return Results.Conflict(BuildConflictProblem(ex.Message));
                    }
                })
            .WithTags("ShopUsers")
            .WithOpenApi(operation =>
            {
                operation.Summary = "Mettre à jour un utilisateur magasin";
                operation.Description = "Modifie un utilisateur de boutique et renvoie son état actualisé.";
                return operation;
            })
            .Produces<ShopUserDto>(StatusCodes.Status200OK)
            .Produces<ProblemDetails>(StatusCodes.Status400BadRequest)
            .Produces<ProblemDetails>(StatusCodes.Status404NotFound)
            .Produces<ProblemDetails>(StatusCodes.Status409Conflict)
            .AddEndpointFilter<RequireOperatorHeadersFilter>()
            .AddEndpointFilter<RequireShopAdminFilter>()
            .RequireAuthorization("Admin");
    }

    private static void MapDeleteShopUserEndpoint(RouteGroupBuilder group)
    {
        ArgumentNullException.ThrowIfNull(group);

        group.MapDelete(
                string.Empty,
                async (
                    [FromRoute(Name = "shopId")] Guid shopId,
                    [FromBody] DeleteShopUserRequest? request,
                    [FromServices] IShopUserService shopUserService,
                    [FromServices] IAuditLogger auditLogger,
                    [FromServices] IClock clock,
                    [FromServices] IValidator<DeleteShopUserRequest> validator,
                    HttpContext httpContext,
                    CancellationToken cancellationToken) =>
                {
                    if (request is null)
                    {
                        return EndpointUtilities.Problem(
                            "Requête invalide",
                            "Le corps de la requête est requis.",
                            StatusCodes.Status400BadRequest);
                    }

                    var validationResult = await validator.ValidateAsync(request, cancellationToken).ConfigureAwait(false);
                    if (!validationResult.IsValid)
                        return EndpointUtilities.ValidationProblem(validationResult);

                    try
                    {
                        var disabled = await shopUserService.SoftDeleteAsync(shopId, request, cancellationToken).ConfigureAwait(false);

                        await LogUserChangeAsync(
                                shopId,
                                $"a désactivé l'utilisateur '{disabled.Login}' ({disabled.Id}).",
                                "shop_users.delete.success",
                                clock,
                                auditLogger,
                                httpContext,
                                cancellationToken)
                            .ConfigureAwait(false);

                        return Results.Ok(disabled);
                    }
                    catch (ShopNotFoundException ex)
                    {
                        return Results.NotFound(BuildProblem(ex.Message, StatusCodes.Status404NotFound));
                    }
                    catch (ShopUserNotFoundException ex)
                    {
                        return Results.NotFound(BuildProblem(ex.Message, StatusCodes.Status404NotFound));
                    }
                })
            .WithTags("ShopUsers")
            .WithOpenApi(operation =>
            {
                operation.Summary = "Désactiver un utilisateur magasin";
                operation.Description = "Désactive un utilisateur de boutique et renvoie son état mis à jour.";
                return operation;
            })
            .Produces<ShopUserDto>(StatusCodes.Status200OK)
            .Produces<ProblemDetails>(StatusCodes.Status400BadRequest)
            .Produces<ProblemDetails>(StatusCodes.Status404NotFound)
            .AddEndpointFilter<RequireOperatorHeadersFilter>()
            .AddEndpointFilter<RequireShopAdminFilter>()
            .RequireAuthorization("Admin");
    }

    private static async Task LogUserChangeAsync(
        Guid shopId,
        string actionDescription,
        string category,
        IClock clock,
        IAuditLogger auditLogger,
        HttpContext httpContext,
        CancellationToken cancellationToken)
    {
        var userName = EndpointUtilities.GetAuthenticatedUserName(httpContext);
        var actor = EndpointUtilities.FormatActorLabel(httpContext);
        var timestamp = EndpointUtilities.FormatTimestamp(clock.UtcNow);
        var message = $"{actor} {actionDescription} Boutique {shopId}. Le {timestamp} UTC.";

        await auditLogger.LogAsync(message, userName, category, cancellationToken).ConfigureAwait(false);
    }

    private static ProblemDetails BuildProblem(string detail, int statusCode = StatusCodes.Status409Conflict) => new()
    {
        Status = statusCode,
        Title = "Requête invalide",
        Detail = detail
    };

    private static ProblemDetails BuildConflictProblem(string detail) => new()
    {
        Status = StatusCodes.Status409Conflict,
        Title = "Identifiant déjà utilisé",
        Detail = detail
    };
}
