using Microsoft.Extensions.Diagnostics.HealthChecks;
using System.Data;
using System.Diagnostics.Metrics;
using CineBoutique.Inventory.Api.Configuration;
using CineBoutique.Inventory.Api.Endpoints;
using CineBoutique.Inventory.Api.Infrastructure.Audit;
using CineBoutique.Inventory.Api.Infrastructure.Authentication;
using CineBoutique.Inventory.Api.Infrastructure.Http;
using CineBoutique.Inventory.Api.Infrastructure.Minimal;
using CineBoutique.Inventory.Api.Infrastructure.Logging;
using CineBoutique.Inventory.Api.Infrastructure.Middleware;
using CineBoutique.Inventory.Api.Infrastructure.Time;
using CineBoutique.Inventory.Api.Infrastructure.Shops;
using CineBoutique.Inventory.Api.Hosting;
using CineBoutique.Inventory.Api.Services;
using CineBoutique.Inventory.Api.Services.Products;
using CineBoutique.Inventory.Api.Services.Products.Import;
using FluentValidation;
using CineBoutique.Inventory.Infrastructure.Database;
using CineBoutique.Inventory.Infrastructure.DependencyInjection;
using CineBoutique.Inventory.Infrastructure.Migrations;
using CineBoutique.Inventory.Infrastructure.Seeding;
using FluentValidation.AspNetCore;
using FluentMigrator.Runner;
using FluentMigrator.Runner.Processors;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Net.Http.Headers;
using Npgsql;
using Microsoft.OpenApi.Models;
using Serilog; // requis pour UseSerilog()
using CineBoutique.Inventory.Api.Infrastructure.Health;
using AppLog = CineBoutique.Inventory.Api.Hosting.Log;
using Dapper;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using CineBoutique.Inventory.Api.Infrastructure.Swagger;
using CineBoutique.Inventory.Api.Features.Inventory.Sessions;
using CineBoutique.Inventory.Api.Features.Shops;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateOnBuild = false;
    options.ValidateScopes = false;
});

builder.Configuration
    .AddJsonFile("appsettings.json", optional: false, reloadOnChange: false)
    .AddJsonFile($"appsettings.{builder.Environment.EnvironmentName}.json", optional: true)
    .AddEnvironmentVariables();

var disableSerilog = builder.Configuration["DISABLE_SERILOG"]?.Equals("true", StringComparison.OrdinalIgnoreCase) == true;

var allowedOrigins = builder.Configuration.GetSection("AllowedOrigins").Get<string[]>() ?? Array.Empty<string>();
if (allowedOrigins.Length == 0)
{
    allowedOrigins = AppDefaults.DevOrigins;
}

var useSerilog = !disableSerilog;

if (useSerilog)
{
    builder.Host.UseSerilog((context, services, configuration) => configuration
        .ReadFrom.Configuration(context.Configuration)
        .ReadFrom.Services(services));
}
else
{
    builder.Logging.ClearProviders();
    builder.Logging.AddConsole();
}

// === CHAÎNE DE CONNEXION UNIQUE POUR TOUT ===
var connectionString = builder.Configuration.GetConnectionString("Default");
if (string.IsNullOrWhiteSpace(connectionString))
{
    throw new InvalidOperationException("La chaîne de connexion 'Default' doit être configurée.");
}

// Log de contrôle au démarrage (host/db utilisateur/ssl)
try
{
    var csb = new NpgsqlConnectionStringBuilder(connectionString);
    Console.WriteLine($"[DB] Host={csb.Host} Db={csb.Database} User={csb.Username} SSL={csb.SslMode}");
}
catch { /* pas bloquant en tests */ }

// Infrastructure + seeder
builder.Services.AddInventoryInfrastructure(builder.Configuration);
builder.Services.AddTransient<InventoryDataSeeder>();
builder.Services.AddScoped<StartInventoryRunHandler>();
builder.Services.AddScoped<CompleteInventoryRunHandler>();
builder.Services.AddScoped<ReleaseInventoryRunHandler>();
builder.Services.AddScoped<RestartInventoryRunHandler>();
builder.Services.AddScoped<ResetShopInventoryHandler>();

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<RequireOperatorHeadersFilter>();
builder.Services.AddSingleton<IShopResolver, DefaultShopResolver>();
builder.Services.Configure<AppSettingsOptions>(builder.Configuration.GetSection("AppSettings"));

var useAdminHeaderAuth = builder.Configuration.GetValue<bool?>("Authentication:UseAdminHeader") ?? true;
var adminEndpointsPublic = builder.Configuration.GetValue<bool?>("AppSettings:AdminEndpointsPublic") ?? false;

var authenticationBuilder = builder.Services.AddAuthentication(options =>
{
    if (useAdminHeaderAuth)
    {
        options.DefaultAuthenticateScheme = AdminHeaderAuthenticationHandler.SchemeName;
        options.DefaultChallengeScheme = AdminHeaderAuthenticationHandler.SchemeName;
    }
    else
    {
        options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
        options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
    }
});

if (useAdminHeaderAuth)
{
    var appToken = builder.Configuration["Authentication:AppToken"];
    if (builder.Environment.IsProduction() && string.IsNullOrWhiteSpace(appToken))
    {
        throw new InvalidOperationException(
            "Authentication:AppToken doit être défini en Production lorsque le schéma AdminHeader est actif (voir secrets.env.example).");
    }

    authenticationBuilder.AddScheme<AdminHeaderAuthenticationOptions, AdminHeaderAuthenticationHandler>(
        AdminHeaderAuthenticationHandler.SchemeName,
        options => options.AppToken = appToken);
}
else
{
    var authority = builder.Configuration["Authentication:Authority"];
    var audience = builder.Configuration["Authentication:Audience"];

    if (string.IsNullOrWhiteSpace(authority))
    {
        throw new InvalidOperationException("Authentication:Authority must be configured outside Development or Testing environments.");
    }

    if (string.IsNullOrWhiteSpace(audience))
    {
        throw new InvalidOperationException("Authentication:Audience must be configured outside Development or Testing environments.");
    }

    authenticationBuilder.AddJwtBearer(options =>
    {
        options.Authority = authority;
        options.Audience = audience;
    });
}

builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("Admin", policy =>
    {
        if (adminEndpointsPublic)
        {
            policy.RequireAssertion(_ => true);
            return;
        }

        if (useAdminHeaderAuth)
        {
            policy.RequireAssertion(context =>
            {
                if (context.User?.Identity?.IsAuthenticated == true)
                {
                    if (context.User.IsInRole("Admin"))
                    {
                        return true;
                    }

                    if (context.User.HasClaim(claim =>
                            string.Equals(claim.Type, "is_admin", StringComparison.OrdinalIgnoreCase) &&
                            string.Equals(claim.Value, "true", StringComparison.OrdinalIgnoreCase)))
                    {
                        return true;
                    }
                }

                if (context.Resource is HttpContext httpContext &&
                    httpContext.Request.Headers.TryGetValue("X-Admin", out var headerValues))
                {
                    foreach (var value in headerValues)
                    {
                        if (string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(value, "1", StringComparison.OrdinalIgnoreCase))
                        {
                            return true;
                        }
                    }
                }

                return false;
            });
        }
        else
        {
            policy.RequireRole("Admin");
        }
    });
});

// --- Swagger ---
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new() { Title = "CinéBoutique Inventory API", Version = "v1" });
    c.SupportNonNullableReferenceTypes();
    var appTokenScheme = new OpenApiSecurityScheme
    {
        Name = SwaggerSecuritySchemeNames.AppToken,
        Description = "Token d'application requis via l'en-tête X-App-Token.",
        In = ParameterLocation.Header,
        Type = SecuritySchemeType.ApiKey,
        Reference = new OpenApiReference
        {
            Type = ReferenceType.SecurityScheme,
            Id = SwaggerSecuritySchemeNames.AppToken
        }
    };
    c.AddSecurityDefinition(SwaggerSecuritySchemeNames.AppToken, appTokenScheme);

    var adminScheme = new OpenApiSecurityScheme
    {
        Name = SwaggerSecuritySchemeNames.Admin,
        Description = "En-tête X-Admin requis avec la valeur true pour les opérations administrateur.",
        In = ParameterLocation.Header,
        Type = SecuritySchemeType.ApiKey,
        Reference = new OpenApiReference
        {
            Type = ReferenceType.SecurityScheme,
            Id = SwaggerSecuritySchemeNames.Admin
        }
    };
    c.AddSecurityDefinition(SwaggerSecuritySchemeNames.Admin, adminScheme);

    c.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        { appTokenScheme, System.Array.Empty<string>() }
    });

    c.OperationFilter<AppTokenSecurityRequirementOperationFilter>();
    c.OperationFilter<CorrelationIdResponseOperationFilter>();

    var asmName = System.Reflection.Assembly.GetExecutingAssembly().GetName().Name;
    var xmlPath = System.IO.Path.Combine(AppContext.BaseDirectory, $"{asmName}.xml");
    if (System.IO.File.Exists(xmlPath))
    {
        c.IncludeXmlComments(xmlPath);
    }
});

// --- JSON options ---
builder.Services
    .AddControllers()
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.JsonSerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
        o.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
        o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
        o.JsonSerializerOptions.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;
        o.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
    });

builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.PropertyNameCaseInsensitive = true;
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
    o.SerializerOptions.Encoder = JavaScriptEncoder.Default;
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddFluentValidationAutoValidation();
builder.Services.AddValidatorsFromAssemblyContaining<CineBoutique.Inventory.Api.Validators.CreateShopRequestValidator>();

// --- Health checks (liveness + readiness) ---
builder.Services
    .AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy())
    .AddCheck<DatabaseHealthCheck>("db", tags: ["ready"]);

// --- Dapper connection ---
builder.Services.AddScoped<IDbConnection>(sp =>
{
    var factory = sp.GetRequiredService<IDbConnectionFactory>();
    return factory.CreateConnection();
});

// IAuditLogger (API) -> DbAuditLogger écrit déjà dans audit_logs
builder.Services.AddScoped<IAuditLogger, DbAuditLogger>();
builder.Services.AddSingleton<IClock, CineBoutique.Inventory.Api.Infrastructure.Time.SystemClock>();

// BRIDGE : remplace l'impl du Domain par le pont vers DbAuditLogger
builder.Services.AddScoped<CineBoutique.Inventory.Domain.Auditing.IAuditLogger, DomainAuditBridgeLogger>();

builder.Services.AddScoped<IShopService, ShopService>();
builder.Services.AddScoped<IShopUserService, ShopUserService>();
builder.Services.AddScoped<IProductLookupService, ProductLookupService>();
builder.Services.AddScoped<IProductSearchService, ProductSearchService>();
builder.Services.AddScoped<IProductSuggestionService, ProductSuggestionService>();
builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource.AddService("cineboutique.inventory.api"))
    .WithMetrics(metrics =>
    {
        metrics.AddMeter(ProductImportMetrics.MeterName, ProductLookupMetrics.MeterName);
        metrics.AddPrometheusExporter();
    });
builder.Services.AddSingleton<IProductImportMetrics>(sp =>
{
    var meterFactory = sp.GetService<IMeterFactory>();
    return meterFactory is null ? new NullProductImportMetrics() : new ProductImportMetrics(meterFactory);
});
builder.Services.AddSingleton<IProductLookupMetrics>(sp =>
{
    var meterFactory = sp.GetService<IMeterFactory>();
    return meterFactory is null ? new NullProductLookupMetrics() : new ProductLookupMetrics(meterFactory);
});
builder.Services.AddScoped<IProductImportReader, ProductImportReader>();
builder.Services.AddScoped<IProductImportValidator, ProductImportValidator>();
builder.Services.AddScoped<IProductImportWriter, ProductImportWriter>();
builder.Services.AddScoped<IProductImportHistoryStore, DapperProductImportHistoryStore>();
builder.Services.AddScoped<IProductImportService, ProductImportService>();

// --- CORS ---
const string PublicApiCorsPolicy = "PublicApi";
const string DevCorsPolicy = "AllowDev";
builder.Services.AddCors(options =>
{
    options.AddPolicy(DevCorsPolicy, policyBuilder =>
    {
        policyBuilder
            .WithOrigins(AppDefaults.DevOrigins)
            .AllowAnyHeader()
            .AllowAnyMethod();
    });

    options.AddPolicy(PublicApiCorsPolicy, policyBuilder =>
    {
        if (allowedOrigins.Length > 0)
        {
            // Ajouter l’IP LAN si besoin (ex: http://192.168.1.42:5173)
            policyBuilder.WithOrigins(allowedOrigins).AllowCredentials();
        }
        else
        {
            policyBuilder.SetIsOriginAllowed(_ => true);
        }

        policyBuilder
            .WithMethods(AppDefaults.CorsMethods)
            .AllowAnyHeader()
            .SetPreflightMaxAge(TimeSpan.FromHours(1));
    });
});

// --- Logging ---
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(options =>
{
    options.SingleLine = true;
    options.TimestampFormat = "HH:mm:ss ";
});
builder.Logging.SetMinimumLevel(LogLevel.Information);

// === FluentMigrator: UN SEUL BLOC, SUR 'Default' ===
builder.Services
    .AddFluentMigratorCore()
    .ConfigureRunner(rb => rb
        .AddPostgres()
        .WithGlobalConnectionString(connectionString)
        .ScanIn(typeof(Program).Assembly, typeof(MigrationsAssemblyMarker).Assembly).For.Migrations())
    .AddLogging(lb => lb.AddFluentMigratorConsole());

builder.Services.Configure<SelectingProcessorAccessorOptions>(options =>
{
    options.ProcessorId = "Postgres";
});

builder.Services
    .AddOptions<ProcessorOptions>()
    .Configure(options =>
    {
        options.Timeout = TimeSpan.FromSeconds(90);
        options.ProviderSwitches = string.Empty;
        options.PreviewOnly = false;
    });

builder.Services.AddSingleton(sp => sp.GetRequiredService<IOptions<ProcessorOptions>>().Value);

// --- App ---
var app = builder.Build();

var applyAutomaticMigrations = app.Environment.IsDevelopment()
    || app.Environment.IsEnvironment("CI")
    || app.Environment.IsEnvironment("Test")
    || app.Environment.IsEnvironment("Testing");

if (applyAutomaticMigrations)
{
    using var scope = app.Services.CreateScope();
    var runner = scope.ServiceProvider.GetRequiredService<IMigrationRunner>();
    try
    {
        runner.MigrateUp();
        app.Logger.LogInformation("Migrations automatiques appliquées pour l'environnement {Environment}.", app.Environment.EnvironmentName);
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "Échec de l'application automatique des migrations");
        throw;
    }
}

// Seeding en dev
if (app.Environment.IsDevelopment())
{
    using var scope = app.Services.CreateScope();
    var seeder = scope.ServiceProvider.GetRequiredService<CineBoutique.Inventory.Infrastructure.Seeding.InventoryDataSeeder>();

    const int max = 10;
    for (var i = 1; i <= max; i++)
    {
        try
        {
            await seeder.SeedAsync();
            app.Logger.LogInformation("Database seeded.");
            break;
        }
        catch (Npgsql.NpgsqlException ex) when (i < max)
        {
            app.Logger.LogWarning(ex, "DB not ready yet (attempt {Attempt}/{Max}), retrying in 1s…", i, max);
            await Task.Delay(1000);
        }
    }
}

var env = app.Environment;

ApiLog.ApiReady(app.Logger);

app.Logger.LogInformation("ASPNETCORE_ENVIRONMENT = {Env}", env.EnvironmentName);
var devLike = env.IsDevelopment() || env.IsEnvironment("CI") || 
              string.Equals(env.EnvironmentName, "Docker", StringComparison.OrdinalIgnoreCase);

if (devLike)
{
    app.UseDeveloperExceptionPage();
}
else
{
    app.UseExceptionHandler(errorApp =>
    {
        errorApp.Run(async context =>
        {
            var feature = context.Features.Get<IExceptionHandlerFeature>();
            var problem = new ProblemDetails
            {
                Title = "Une erreur est survenue lors du traitement de votre requête.",
                Status = StatusCodes.Status500InternalServerError,
                Detail = null // on n’expose pas le détail hors dev-like
            };

            context.Response.StatusCode = problem.Status ?? StatusCodes.Status500InternalServerError;
            context.Response.ContentType = "application/problem+json; charset=utf-8";
            await context.Response.WriteAsJsonAsync(problem).ConfigureAwait(false);
        });
    });
}

// --- FORWARDED HEADERS pour proxy (Nginx) ---
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
});

app.UseStatusCodePages();

app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers[HeaderNames.XContentTypeOptions] = "nosniff";
        return Task.CompletedTask;
    });

    await next().ConfigureAwait(false);
});

// Flags migrations depuis config (conservés)
var applyMigrations = app.Configuration.GetValue<bool>("APPLY_MIGRATIONS");
var disableMigrations = app.Configuration.GetValue<bool>("DISABLE_MIGRATIONS");
AppLog.MigrationsFlags(app.Logger, applyMigrations, disableMigrations);

if (!applyAutomaticMigrations && !app.Environment.IsEnvironment("Testing"))
{
    if (applyMigrations && !disableMigrations)
    {
        const int maxAttempts = 10;
        var attempt = 0;

        while (true)
        {
            try
            {
                attempt++;
                using var scope = app.Services.CreateScope();
                var runner = scope.ServiceProvider.GetRequiredService<IMigrationRunner>();
                runner.MigrateUp();

                var connectionDetails = new NpgsqlConnectionStringBuilder(connectionString);
                AppLog.DbHostDb(app.Logger, $"{connectionDetails.Host}/{connectionDetails.Database}");

                break;
            }
            catch (Exception ex) when (attempt < maxAttempts && ex is NpgsqlException or TimeoutException or InvalidOperationException)
            {
                AppLog.MigrationRetry(app.Logger, attempt, maxAttempts, ex);
                await Task.Delay(TimeSpan.FromSeconds(1)).ConfigureAwait(false);
            }
        }
    }
    else if (applyMigrations)
    {
        AppLog.MigrationsSkipped(app.Logger);
    }
}

var seedOnStartup = app.Configuration.GetValue<bool>("AppSettings:SeedOnStartup");
AppLog.SeedOnStartup(app.Logger, seedOnStartup);

if (seedOnStartup)
{
    using var scope = app.Services.CreateScope();
    var seeder = scope.ServiceProvider.GetRequiredService<InventoryDataSeeder>();
    await seeder.SeedAsync().ConfigureAwait(false);
}

if (app.Environment.IsDevelopment())
{
    app.UseCors(DevCorsPolicy);
}
else
{
    app.UseCors(PublicApiCorsPolicy);
}

app.UseMiddleware<AppTokenGuardMiddleware>();

if (app.Environment.IsDevelopment() || app.Environment.IsEnvironment("Testing"))
{
    app.UseSwagger();
    app.UseSwaggerUI(c =>
    {
        c.SwaggerEndpoint("/swagger/v1/swagger.json", "CinéBoutique Inventory API v1");
        c.RoutePrefix = "swagger";
    });
}

if (useSerilog)
{
    app.UseSerilogRequestLogging();
}

app.UseMiddleware<CorrelationIdMiddleware>();

app.UseMiddleware<LegacyOperatorNameWriteGuardMiddleware>();
app.UseMiddleware<SoftOperatorMiddleware>();

app.UseAuthentication();
app.UseAuthorization();

var metricsEndpoint = app.MapPrometheusScrapingEndpoint("/metrics");
if (devLike)
{
    metricsEndpoint.AllowAnonymous();
}
else
{
    metricsEndpoint.RequireAuthorization("Admin");
}

app.Use(async (ctx, next) =>
{
    try
    {
        await next().ConfigureAwait(false);
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "Unhandled exception for {Method} {Path}", ctx.Request?.Method, ctx.Request?.Path);
        throw; // laisse l’exception remonter à DeveloperExceptionPage / ExceptionHandler
    }
});

app.MapHealthEndpoints();
app.MapDiagnosticsEndpoints();
app.MapInventoryEndpoints();
app.MapProductEndpoints();
app.MapShopsEndpoints();
app.MapShopUsersEndpoints();

app.MapControllers();

// Voir l'environnement et quelques flags runtime
if (app.Environment.IsDevelopment())
{
    app.MapGet("/__debug/env", (IConfiguration cfg, IWebHostEnvironment e) =>
    {
        return Results.Ok(new
        {
            Environment = e.EnvironmentName,
            DetailedErrors = cfg["ASPNETCORE_DETAILEDERRORS"],
            ApplyMigrations = cfg["APPLY_MIGRATIONS"],
            DisableMigrations = cfg["DISABLE_MIGRATIONS"]
        });
    }).AllowAnonymous();

    // Valider la chaîne de connexion effective et ping DB
    app.MapGet("/__debug/db", async (IDbConnection connection) =>
    {
        try
        {
            var version = await connection.ExecuteScalarAsync<string>("select version();").ConfigureAwait(false);
            return Results.Ok(new { ok = true, version });
        }
        catch (Exception ex)
        {
            return Results.Problem(detail: ex.ToString(), title: "db_ping_failed");
        }
    }).AllowAnonymous();
}

await app.RunAsync().ConfigureAwait(false);

public partial class Program { }

internal static class AppDefaults
{
    public static readonly string[] DevOrigins =
    [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ];

    public static readonly string[] CorsMethods =
    [
        "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"
    ];
}
