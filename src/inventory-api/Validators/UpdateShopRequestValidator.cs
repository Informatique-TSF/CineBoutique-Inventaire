using System.Text.RegularExpressions;
using CineBoutique.Inventory.Api.Models;
using FluentValidation;

namespace CineBoutique.Inventory.Api.Validators;

public sealed class UpdateShopRequestValidator : AbstractValidator<UpdateShopRequest>
{
    private static readonly Regex OfficeCodePattern =
        new("^[A-Za-z0-9]{2,16}$", RegexOptions.CultureInvariant);

    public UpdateShopRequestValidator()
    {
        RuleFor(request => request.Id)
            .NotEmpty().WithMessage("L'identifiant de la boutique est requis.");

        RuleFor(request => request.Name)
            .Cascade(CascadeMode.Stop)
            .NotEmpty().WithMessage("Le nom de la boutique est obligatoire.")
            .Must(name => name.Trim().Length > 0).WithMessage("Le nom de la boutique ne peut pas être vide.")
            .MaximumLength(256).WithMessage("Le nom de la boutique ne peut pas dépasser 256 caractères.");

        RuleFor(request => request.OfficeCode)
            .Must(code => string.IsNullOrWhiteSpace(code) || OfficeCodePattern.IsMatch(code.Trim()))
            .WithMessage("Le code office doit contenir de 2 à 16 lettres ou chiffres (ex. MTP).");
    }
}
