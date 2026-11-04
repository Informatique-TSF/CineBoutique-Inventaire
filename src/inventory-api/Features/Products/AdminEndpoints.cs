using System.Data;
using CineBoutique.Inventory.Api.Endpoints;
using CineBoutique.Inventory.Api.Infrastructure.Audit;
using CineBoutique.Inventory.Api.Infrastructure.Minimal;
using CineBoutique.Inventory.Api.Infrastructure.Shops;
using CineBoutique.Inventory.Api.Infrastructure.Time;
using CineBoutique.Inventory.Api.Models;
using CineBoutique.Inventory.Api.Validation;
using CineBoutique.Inventory.Infrastructure.Database;
using Dapper;
using Npgsql;

namespace CineBoutique.Inventory.Api.Features.Products;

internal static class AdminEndpoints
{
    public static IEndpointRouteBuilder MapProductAdminEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        MapCreateProductEndpoint(app);
        MapUpdateProductEndpoints(app);

        return app;
    }

    private const string LowerSkuConstraintName = "UX_Product_Shop_LowerSku";
    private const string EanNotNullConstraintName = "UX_Product_Shop_Ean_NotNull";
        private static void MapUpdateProductEndpoints(IEndpointRouteBuilder app)
        {
            // --- MAJ par SKU ---

            var updateBySku = async (
                string code,
                CreateProductRequest request,
                IDbConnection connection,
                IAuditLogger auditLogger,
                IClock clock,
                HttpContext httpContext,
                CancellationToken cancellationToken) =>
            {
                var sku = code;
                if (string.IsNullOrWhiteSpace(sku))
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, "(SKU vide)", "sans sku", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le SKU (dans l'URL) est requis." });
                }

                if (request is null)
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, sku, "corps null", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le corps de la requête est requis." });
                }

                var sanitizedSku = sku.Trim();
                var sanitizedName = request.Name?.Trim();
                var sanitizedEan = InventoryCodeValidator.Normalize(request.Ean);
                if (sanitizedEan is not null && !InventoryCodeValidator.TryValidate(sanitizedEan, out var eanError))
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, sanitizedSku, "EAN invalide", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = eanError });
                }

                var sanitizedCodeDigits = CodeDigitsSanitizer.Build(sanitizedEan);

                if (string.IsNullOrWhiteSpace(sanitizedName))
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, sanitizedSku, "sans nom", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le nom du produit est requis." });
                }

                if (sanitizedName.Length > 256)
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, sanitizedSku, "nom trop long", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le nom du produit ne peut pas dépasser 256 caractères." });
                }

                await EndpointUtilities.EnsureConnectionOpenAsync(connection, cancellationToken).ConfigureAwait(false);

                // Récupère le produit par SKU (case-insensitive)
                const string fetchSql = @"SELECT ""Id"", ""Sku"", ""Name"", ""Ean""
                                      FROM ""Product""
                                      WHERE LOWER(""Sku"") = LOWER(@Sku)
                                      LIMIT 1;";
                var existing = await connection.QueryFirstOrDefaultAsync<ProductDto>(
                    new CommandDefinition(fetchSql, new { Sku = sanitizedSku }, cancellationToken: cancellationToken)).ConfigureAwait(false);

                if (existing is null)
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, sanitizedSku, "inexistant", "products.update.notfound", cancellationToken).ConfigureAwait(false);
                    return Results.NotFound(new { message = $"Aucun produit avec le SKU '{sanitizedSku}'." });
                }

                const string updateSql = @"UPDATE ""Product""
                                       SET ""Name"" = @Name, ""Ean"" = @Ean, ""CodeDigits"" = @CodeDigits
                                       WHERE ""Id"" = @Id
                                       RETURNING ""Id"", ""Sku"", ""Name"", ""Ean"";";
                try
                {
                    var updated = await connection.QuerySingleAsync<ProductDto>(
                        new CommandDefinition(updateSql, new { Id = existing.Id, Name = sanitizedName, Ean = sanitizedEan, CodeDigits = sanitizedCodeDigits }, cancellationToken: cancellationToken)).ConfigureAwait(false);

                    return Results.Ok(updated);
                }
                catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UniqueViolation)
                {
                    if (string.Equals(ex.ConstraintName, EanNotNullConstraintName, StringComparison.Ordinal))
                    {
                        await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, sanitizedSku, $"EAN déjà utilisé ({sanitizedEan})", "products.update.conflict", cancellationToken).ConfigureAwait(false);
                        return Results.Conflict(new { message = "Cet EAN est déjà utilisé." });
                    }

                    if (string.Equals(ex.ConstraintName, LowerSkuConstraintName, StringComparison.Ordinal))
                    {
                        await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, sanitizedSku, "SKU déjà utilisé", "products.update.conflict", cancellationToken).ConfigureAwait(false);
                        return Results.Conflict(new { message = "Ce SKU est déjà utilisé." });
                    }

                    throw;
                }
            };

            app.MapPost("/api/products/{code}", updateBySku)
               .WithName("UpdateProductBySkuPost")
               .WithTags("Produits")
               .Produces<ProductDto>(StatusCodes.Status200OK)
               .Produces(StatusCodes.Status400BadRequest)
               .Produces(StatusCodes.Status404NotFound)
               .Produces(StatusCodes.Status409Conflict)
               .WithOpenApi(op =>
               {
                   op.Summary = "Met à jour un produit par SKU (POST compat).";
                   op.Description = "Modifie le nom et/ou l'EAN du produit identifié par son SKU.";
                   return op;
               })
               .AddEndpointFilter<RequireOperatorHeadersFilter>()
               .AddEndpointFilter<RequireShopAdminFilter>()
               .RequireAuthorization("Admin");

            app.MapPut("/api/products/{code}", updateBySku)
               .WithName("UpdateProductBySku")
               .WithTags("Produits")
               .Produces<ProductDto>(StatusCodes.Status200OK)
               .Produces(StatusCodes.Status400BadRequest)
               .Produces(StatusCodes.Status404NotFound)
               .Produces(StatusCodes.Status409Conflict)
               .AddEndpointFilter<RequireOperatorHeadersFilter>()
               .AddEndpointFilter<RequireShopAdminFilter>()
               .RequireAuthorization("Admin");

            // --- MAJ par Id (GUID) ---

            var updateById = async (
                Guid id,
                CreateProductRequest request,
                IDbConnection connection,
                IAuditLogger auditLogger,
                IClock clock,
                HttpContext httpContext,
                CancellationToken cancellationToken) =>
            {
                if (request is null)
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, id.ToString("D"), "corps null", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le corps de la requête est requis." });
                }

                var sanitizedName = request.Name?.Trim();
                var sanitizedEan = InventoryCodeValidator.Normalize(request.Ean);
                if (sanitizedEan is not null && !InventoryCodeValidator.TryValidate(sanitizedEan, out var eanError))
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, id.ToString("D"), "EAN invalide", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = eanError });
                }

                var sanitizedCodeDigits = CodeDigitsSanitizer.Build(sanitizedEan);

                if (string.IsNullOrWhiteSpace(sanitizedName))
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, id.ToString("D"), "sans nom", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le nom du produit est requis." });
                }

                if (sanitizedName.Length > 256)
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, id.ToString("D"), "nom trop long", "products.update.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le nom du produit ne peut pas dépasser 256 caractères." });
                }

                await EndpointUtilities.EnsureConnectionOpenAsync(connection, cancellationToken).ConfigureAwait(false);

                // Vérifie l'existence
                const string existsSql = @"SELECT ""Id"", ""Sku"", ""Name"", ""Ean""
                                       FROM ""Product"" WHERE ""Id"" = @Id LIMIT 1;";
                var existing = await connection.QueryFirstOrDefaultAsync<ProductDto>(
                    new CommandDefinition(existsSql, new { Id = id }, cancellationToken: cancellationToken)).ConfigureAwait(false);

                if (existing is null)
                {
                    await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, id.ToString("D"), "inexistant", "products.update.notfound", cancellationToken).ConfigureAwait(false);
                    return Results.NotFound(new { message = $"Aucun produit avec l'Id '{id.ToString("D")}'." });
                }

                const string updateSql = @"UPDATE ""Product""
                                       SET ""Name"" = @Name, ""Ean"" = @Ean, ""CodeDigits"" = @CodeDigits
                                       WHERE ""Id"" = @Id
                                       RETURNING ""Id"", ""Sku"", ""Name"", ""Ean"";";
                try
                {
                    var updated = await connection.QuerySingleAsync<ProductDto>(
                        new CommandDefinition(updateSql, new { Id = id, Name = sanitizedName, Ean = sanitizedEan, CodeDigits = sanitizedCodeDigits }, cancellationToken: cancellationToken)).ConfigureAwait(false);

                    return Results.Ok(updated);
                }
                catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UniqueViolation)
                {
                    if (string.Equals(ex.ConstraintName, EanNotNullConstraintName, StringComparison.Ordinal))
                    {
                        await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, id.ToString("D"), $"EAN déjà utilisé ({sanitizedEan})", "products.update.conflict", cancellationToken).ConfigureAwait(false);
                        return Results.Conflict(new { message = "Cet EAN est déjà utilisé." });
                    }

                    if (string.Equals(ex.ConstraintName, LowerSkuConstraintName, StringComparison.Ordinal))
                    {
                        await LogProductUpdateAttemptAsync(clock, auditLogger, httpContext, id.ToString("D"), "SKU déjà utilisé", "products.update.conflict", cancellationToken).ConfigureAwait(false);
                        return Results.Conflict(new { message = "Ce SKU est déjà utilisé." });
                    }

                    throw;
                }
            };

            app.MapPost("/api/products/by-id/{id:guid}", updateById)
               .WithName("UpdateProductByIdPost")
               .WithTags("Produits")
               .Produces<ProductDto>(StatusCodes.Status200OK)
               .Produces(StatusCodes.Status400BadRequest)
               .Produces(StatusCodes.Status404NotFound)
               .Produces(StatusCodes.Status409Conflict)
               .AddEndpointFilter<RequireOperatorHeadersFilter>()
               .AddEndpointFilter<RequireShopAdminFilter>()
               .RequireAuthorization("Admin");

            app.MapPut("/api/products/by-id/{id:guid}", updateById)
               .WithName("UpdateProductById")
               .WithTags("Produits")
               .Produces<ProductDto>(StatusCodes.Status200OK)
               .Produces(StatusCodes.Status400BadRequest)
               .Produces(StatusCodes.Status404NotFound)
               .Produces(StatusCodes.Status409Conflict)
               .AddEndpointFilter<RequireOperatorHeadersFilter>()
               .AddEndpointFilter<RequireShopAdminFilter>()
               .RequireAuthorization("Admin");
        }

        private static void MapCreateProductEndpoint(IEndpointRouteBuilder app)
        {
            app.MapPost("/api/products", async (
                CreateProductRequest request,
                IDbConnection connection,
                IAuditLogger auditLogger,
                IClock clock,
                IShopResolver shopResolver,
                HttpContext httpContext,
                CancellationToken cancellationToken) =>
            {
                if (request is null)
                    return Results.BadRequest(new { message = "Le corps de la requête est requis." });

                var sanitizedSku = request.Sku?.Trim();
                var sanitizedName = request.Name?.Trim();
                var sanitizedEan = InventoryCodeValidator.Normalize(request.Ean);
                if (sanitizedEan is not null && !InventoryCodeValidator.TryValidate(sanitizedEan, out var eanError))
                {
                    await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, "avec un EAN invalide", "products.create.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = eanError });
                }

                var sanitizedCodeDigits = CodeDigitsSanitizer.Build(sanitizedEan);

                if (string.IsNullOrWhiteSpace(sanitizedSku))
                {
                    await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, "sans SKU", "products.create.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le SKU est requis." });
                }

                if (sanitizedSku.Length > 32)
                {
                    await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, "avec un SKU trop long", "products.create.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le SKU ne peut pas dépasser 32 caractères." });
                }

                if (string.IsNullOrWhiteSpace(sanitizedName))
                {
                    await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, "sans nom", "products.create.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le nom du produit est requis." });
                }

                if (sanitizedName.Length > 256)
                {
                    await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, "avec un nom trop long", "products.create.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.BadRequest(new { message = "Le nom du produit ne peut pas dépasser 256 caractères." });
                }

                await EndpointUtilities.EnsureConnectionOpenAsync(connection, cancellationToken).ConfigureAwait(false);

                Guid? shopId = null;
                try
                {
                    shopId = await shopResolver.GetDefaultForBackCompatAsync(connection, cancellationToken).ConfigureAwait(false);
                }
                catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UndefinedTable)
                {
                    // La table des shops n'est pas encore créée : on laisse shopId à null et on gèrera plus bas.
                }
                catch (InvalidOperationException)
                {
                    // Absence de boutique disponible : on gère plus bas.
                }

                if (!shopId.HasValue)
                {
                    await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, "sans boutique", "products.create.invalid", cancellationToken).ConfigureAwait(false);
                    return Results.Problem(
                        statusCode: StatusCodes.Status503ServiceUnavailable,
                        title: "Aucune boutique disponible",
                        detail: "Impossible de créer un produit sans boutique active.");
                }

                const string insertSql = @"INSERT INTO ""Product"" (""Id"", ""ShopId"", ""Sku"", ""Name"", ""Ean"", ""CodeDigits"", ""CreatedAtUtc"")
    VALUES (@Id, @ShopId, @Sku, @Name, @Ean, @CodeDigits, @CreatedAtUtc)
    ON CONFLICT (""ShopId"", LOWER(""Sku"")) DO NOTHING
    RETURNING ""Id"", ""Sku"", ""Name"", ""Ean"";";

                var now = clock.UtcNow;
                try
                {
                    var createdProduct = await connection.QuerySingleOrDefaultAsync<ProductDto>(
                        new CommandDefinition(
                            insertSql,
                            new
                            {
                                Id = Guid.NewGuid(),
                                Sku = sanitizedSku,
                                Name = sanitizedName,
                                Ean = sanitizedEan,
                                CodeDigits = sanitizedCodeDigits,
                                CreatedAtUtc = now,
                                ShopId = shopId.Value
                            },
                            cancellationToken: cancellationToken)).ConfigureAwait(false);

                    if (createdProduct is null)
                    {
                        await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, $"avec un SKU déjà utilisé ({sanitizedSku})", "products.create.conflict", cancellationToken).ConfigureAwait(false);
                        return Results.Conflict(new { message = "Ce SKU est déjà utilisé." });
                    }

                    var location = $"/api/products/{Uri.EscapeDataString(createdProduct.Sku)}";
                    return Results.Created(location, createdProduct);
                }
                catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UniqueViolation)
                {
                    if (string.Equals(ex.ConstraintName, EanNotNullConstraintName, StringComparison.Ordinal))
                    {
                        var eanLabel = string.IsNullOrWhiteSpace(sanitizedEan) ? "(EAN non renseigné)" : sanitizedEan;
                        await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, $"avec un EAN déjà utilisé ({eanLabel})", "products.create.conflict", cancellationToken).ConfigureAwait(false);
                        return Results.Conflict(new { message = "Cet EAN est déjà utilisé." });
                    }

                    if (string.Equals(ex.ConstraintName, LowerSkuConstraintName, StringComparison.Ordinal))
                    {
                        await LogProductCreationAttemptAsync(clock, auditLogger, httpContext, $"avec un SKU déjà utilisé ({sanitizedSku})", "products.create.conflict", cancellationToken).ConfigureAwait(false);
                        return Results.Conflict(new { message = "Ce SKU est déjà utilisé." });
                    }

                    throw;
                }
            })
            .WithName("CreateProduct")
            .WithTags("Produits")
            .Produces<ProductDto>(StatusCodes.Status201Created)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status409Conflict)
            .WithOpenApi(op =>
            {
                op.Summary = "Crée un nouveau produit.";
                op.Description = "Permet l'ajout manuel d'un produit en spécifiant son SKU, son nom et éventuellement un code EAN.";
                return op;
            })
            .AddEndpointFilter<RequireOperatorHeadersFilter>()
            .AddEndpointFilter<RequireShopAdminFilter>()
            .RequireAuthorization("Admin");
        }

        private static async Task LogProductCreationAttemptAsync(
            IClock clock,
            IAuditLogger auditLogger,
            HttpContext httpContext,
            string details,
            string category,
            CancellationToken cancellationToken)
        {
            var now = clock.UtcNow;
            var userName = EndpointUtilities.GetAuthenticatedUserName(httpContext);
            var actor = EndpointUtilities.FormatActorLabel(httpContext);
            var timestamp = EndpointUtilities.FormatTimestamp(now);
            var message = $"{actor} a tenté de créer un produit {details} le {timestamp} UTC.";
            await auditLogger.LogAsync(message, userName, category, cancellationToken).ConfigureAwait(false);
        }

        private static async Task LogProductUpdateAttemptAsync(
            IClock clock,
            IAuditLogger auditLogger,
            HttpContext httpContext,
            string target,          // SKU ou Id
            string details,         // ex: "sans nom", "EAN invalide", "inexistant", ...
            string category,        // ex: "products.update.invalid"
            CancellationToken cancellationToken)
        {
            var now = clock.UtcNow;
            var userName = EndpointUtilities.GetAuthenticatedUserName(httpContext);
            var actor = EndpointUtilities.FormatActorLabel(httpContext);
            var timestamp = EndpointUtilities.FormatTimestamp(now);
            var message = $"{actor} a tenté de mettre à jour le produit '{target}' {details} le {timestamp} UTC.";
            await auditLogger.LogAsync(message, userName, category, cancellationToken).ConfigureAwait(false);
        }
}
